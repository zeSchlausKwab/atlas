//! Construct RCL2 directly, one cell at a time. The complete graph never exists in RAM.
//! Segment IDs follow the canonical source-way order, exactly like the regional importer.
use crate::{
    graph_checkpoint::{next_block, seek, Needed, Progress, State},
    node_store::{NodeStore, NodeWriter},
    transport,
    transport_import::{restriction, turn_kind},
};
use atlas_routing::{
    cells::{cell, Cell},
    distance, Graph, Node, Segment, Turn,
};
use osmpbfreader::{blocks, OsmId, OsmObj};
use rusqlite::{params, Connection};
use serde_json::json;
use std::{
    collections::HashMap,
    io::{BufWriter, Read, Seek, Write},
    path::Path,
};
type Error = Box<dyn std::error::Error>;

// Output is a backpressured framed stream: u32 key length, u32 payload length, key, payload.
fn frame(out: &mut impl Write, key: &str, bytes: &[u8]) -> Result<(), Error> {
    out.write_all(&(u32::try_from(key.len())?).to_le_bytes())?;
    out.write_all(&(u32::try_from(bytes.len())?).to_le_bytes())?;
    out.write_all(key.as_bytes())?;
    out.write_all(bytes)?;
    Ok(())
}
pub fn import(source: &str, work: &str) -> Result<(), Error> {
    std::fs::create_dir_all(work)?;
    let work = Path::new(work);
    let path = work.join("routing-v2.sqlite");
    // The old spool has no durable cursor and cannot safely be resumed.
    let legacy = work.join("routing-spool.sqlite");
    if legacy.exists() {
        std::fs::remove_file(legacy)?;
    }
    let db = Connection::open(&path)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA cache_size=-65536; PRAGMA mmap_size=0;
        CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY,state TEXT);
        CREATE TABLE IF NOT EXISTS excluded(mode INTEGER,way INTEGER,PRIMARY KEY(mode,way)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS turns(mode INTEGER,via INTEGER,f INTEGER,t INTEGER,kind INTEGER,PRIMARY KEY(mode,via,f,t,kind)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS edges(mode INTEGER,cell INTEGER,id INTEGER,a INTEGER,b INTEGER,way INTEGER,flags INTEGER,ax REAL,ay REAL,bx REAL,by REAL,c0 REAL,c1 REAL,PRIMARY KEY(mode,cell,id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS cells(mode INTEGER,cell INTEGER,data BLOB,PRIMARY KEY(mode,cell)) WITHOUT ROWID;")?;
    let mut state = State::open(&db, source)?;
    db.execute_batch("BEGIN IMMEDIATE")?;
    state.commit(&db)?;
    let source_bytes = std::fs::metadata(source)?.len();
    let needed_path = work.join("routing-needed.bits");
    let node_path = work.join("routing-coordinates.bin");
    if state.stage == 0 {
        let mut reader = seek(source, state.offset)?;
        let mut needed = if state.first_way.is_some() {
            Some(Needed::open(&needed_path, state.max_node, true)?)
        } else {
            None
        };
        let mut progress = Progress::new(state.offset);
        progress.report(
            "routing-references",
            "Finding routing nodes and restrictions",
            state.offset,
            source_bytes,
            "bytes",
            1,
        );
        loop {
            let start = reader.stream_position()?;
            let Some(block) = next_block(&mut reader)? else {
                break;
            };
            // IDs alone are enough during the node section: do not decode billions of tags.
            for group in &block.primitivegroup {
                if state.first_way.is_some()
                    && (!group.nodes.is_empty()
                        || group.dense.as_ref().is_some_and(|d| !d.id.is_empty()))
                {
                    return Err(
                        "Routing requires PBF type order (nodes, ways, relations); run osmium sort"
                            .into(),
                    );
                }
                for n in &group.nodes {
                    if n.id() < 0 {
                        return Err("Routing requires non-negative OSM node IDs".into());
                    }
                    state.max_node = state.max_node.max(n.id());
                }
                if let Some(dense) = group.dense.as_ref() {
                    let mut id = 0i64;
                    for delta in &dense.id {
                        id += delta;
                        if id < 0 {
                            return Err("Routing requires non-negative OSM node IDs".into());
                        }
                        state.max_node = state.max_node.max(id);
                    }
                }
            }
            for w in blocks::ways(&block) {
                if state.first_way.is_none() {
                    state.first_way = Some(start);
                    state.node_end = reader.stream_position()?;
                    needed = Some(Needed::open(&needed_path, state.max_node, false)?);
                }
                let mut routable = false;
                for mode in 0..3 {
                    if transport::directions(&w.tags, mode) != 0 {
                        state.totals[mode] += 1;
                        routable = true;
                    }
                }
                if routable {
                    for id in &w.nodes {
                        needed.as_mut().unwrap().insert(id.0);
                    }
                }
            }
            for r in blocks::relations(&block) {
                match OsmObj::Relation(r) {
                    OsmObj::Relation(r)
                        if r.tags.get("type").map(|v| v.as_str()) == Some("restriction") =>
                    {
                        for mode in 0..3 {
                            let Some(value) = restriction(&r.tags, mode) else {
                                continue;
                            };
                            let from: Vec<_> = r
                                .refs
                                .iter()
                                .filter(|m| m.role == "from")
                                .filter_map(|m| {
                                    if let OsmId::Way(id) = m.member {
                                        Some(id.0)
                                    } else {
                                        None
                                    }
                                })
                                .collect();
                            let to: Vec<_> = r
                                .refs
                                .iter()
                                .filter(|m| m.role == "to")
                                .filter_map(|m| {
                                    if let OsmId::Way(id) = m.member {
                                        Some(id.0)
                                    } else {
                                        None
                                    }
                                })
                                .collect();
                            let via: Vec<_> = r.refs.iter().filter(|m| m.role == "via").collect();
                            let node = if via.len() == 1 {
                                if let OsmId::Node(n) = via[0].member {
                                    Some(n.0)
                                } else {
                                    None
                                }
                            } else {
                                None
                            };
                            let conditional = r.tags.keys().any(|k| {
                                k.starts_with("restriction") && k.ends_with(":conditional")
                            });
                            let known = [
                                "no_left_turn",
                                "no_right_turn",
                                "no_straight_on",
                                "no_u_turn",
                                "no_entry",
                                "no_exit",
                                "only_left_turn",
                                "only_right_turn",
                                "only_straight_on",
                                "only_u_turn",
                            ]
                            .contains(&value);
                            if conditional
                                || !known
                                || node.is_none()
                                || from.len() != 1
                                || to.len() != 1
                            {
                                state.unsupported[mode] += 1;
                                for way in from {
                                    db.prepare_cached(
                                        "INSERT OR IGNORE INTO excluded VALUES(?,?)",
                                    )?
                                    .execute(params![mode as u32, way])?;
                                }
                            } else {
                                db.prepare_cached("INSERT OR IGNORE INTO turns VALUES(?,?,?,?,?)")?
                                    .execute(params![
                                        mode as u32,
                                        node.unwrap(),
                                        from[0],
                                        to[0],
                                        turn_kind(value, from[0], to[0])
                                    ])?;
                            }
                        }
                    }

                    _ => {}
                }
            }
            state.offset = reader.stream_position()?;
            if progress.due() {
                if let Some(n) = &needed {
                    n.flush()?;
                }
                state.commit(&db)?;
                progress.report(
                    "routing-references",
                    "Finding routing nodes and restrictions",
                    state.offset,
                    source_bytes,
                    "bytes",
                    1,
                );
            }
        }
        if let Some(n) = &needed {
            n.flush()?;
        } else {
            Needed::open(&needed_path, state.max_node, false)?.flush()?;
        }
        state.stage = 1;
        state.offset = 0;
        state.commit(&db)?;
    }
    if state.stage == 1 {
        let needed = Needed::open(&needed_path, state.max_node, true)?;
        let mut nodes = NodeWriter::resume(&node_path, state.coordinates)?;
        let mut reader = seek(source, state.offset)?;
        let total = if state.first_way.is_some() {
            state.node_end
        } else {
            source_bytes
        };
        let mut progress = Progress::new(state.offset);
        progress.report(
            "routing-coordinates",
            "Indexing only coordinates used by routing",
            state.offset,
            total,
            "bytes",
            2,
        );
        while reader.stream_position()? < total {
            let Some(block) = next_block(&mut reader)? else {
                break;
            };
            for n in blocks::nodes(&block) {
                if needed.contains(n.id.0) {
                    nodes.push(
                        n.id,
                        [n.decimicro_lon, n.decimicro_lat],
                        std::array::from_fn(|m| transport::blocked(&n.tags, m)),
                    )?;
                }
            }
            state.offset = reader.stream_position()?;
            if progress.due() {
                state.coordinates = nodes.checkpoint()?;
                state.commit(&db)?;
                progress.report(
                    "routing-coordinates",
                    &format!("Indexed {} routing coordinates", state.coordinates),
                    state.offset,
                    total,
                    "bytes",
                    2,
                );
            }
        }
        state.coordinates = nodes.checkpoint()?;
        state.stage = 2;
        state.offset = state.first_way.unwrap_or(source_bytes);
        state.commit(&db)?;
    }
    let nodes = if state.stage < 8 {
        Some(NodeStore::open(&node_path, state.coordinates)?)
    } else {
        None
    };
    for mode in 0usize..3 {
        let label = transport::MODES[mode];
        if state.stage == 2 + mode * 2 {
            let nodes = nodes.as_ref().unwrap();
            let mut reader = seek(source, state.offset)?;
            let mut progress = Progress::new(state.ways);
            progress.report(
                &format!("routing-{label}"),
                &format!("Partitioning {label} graph"),
                state.ways,
                state.totals[mode],
                "ways",
                3 + mode * 2,
            );
            while let Some(block) = next_block(&mut reader)? {
                for object in blocks::ways(&block).map(OsmObj::Way) {
                    if let OsmObj::Way(w) = object {
                        let modes: Vec<_> = [mode]
                            .into_iter()
                            .filter(|mode| transport::directions(&w.tags, *mode) != 0)
                            .collect();
                        if modes.is_empty() {
                            continue;
                        }
                        let coordinates: Option<Vec<_>> =
                            w.nodes.iter().map(|id| nodes.get(id)).collect();
                        for mode in modes {
                            let directions = transport::directions(&w.tags, mode);
                            if directions == 0
                                || db
                                    .prepare_cached(
                                        "SELECT 1 FROM excluded WHERE mode=? AND way=?",
                                    )?
                                    .exists(params![mode as u32, w.id.0])?
                            {
                                continue;
                            }
                            let Some(coords) = &coordinates else {
                                state.skipped[mode] += 1;
                                continue;
                            };
                            let speeds = transport::speeds(&w.tags, mode);
                            for (i, pair) in w.nodes.windows(2).enumerate() {
                                let (a, b) = (coords[i], coords[i + 1]);
                                if pair[0] == pair[1] || a.1[mode] || b.1[mode] {
                                    continue;
                                }
                                let id = u32::try_from(state.ids[mode])
                                    .map_err(|_| "RCL2 segment identity space exhausted")?;
                                state.ids[mode] += 1;
                                let (ca, cb) = (cell(a.0), cell(b.0));
                                let (xmin, xmax, ymin, ymax) = (
                                    ca.0.min(cb.0),
                                    ca.0.max(cb.0),
                                    ca.1.min(cb.1),
                                    ca.1.max(cb.1),
                                );
                                if (xmax - xmin + 1) as u64 * (ymax - ymin + 1) as u64 > 4096 {
                                    return Err("Routing segment spans too many cells".into());
                                }
                                let meters = distance(a.0, b.0);
                                for x in xmin..=xmax {
                                    for y in ymin..=ymax {
                                        db.prepare_cached(
                                            "INSERT INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                        )?
                                        .execute(
                                            params![
                                                mode as u32,
                                                (x as u64) * 16384 + y as u64,
                                                id,
                                                pair[0].0,
                                                pair[1].0,
                                                w.id.0,
                                                directions,
                                                a.0[0],
                                                a.0[1],
                                                b.0[0],
                                                b.0[1],
                                                meters / speeds[0],
                                                meters / speeds[1]
                                            ],
                                        )?;
                                    }
                                }
                            }
                        }
                        state.ways += 1;
                    }
                }
                state.offset = reader.stream_position()?;
                if progress.due() {
                    state.commit(&db)?;
                    progress.report(
                        &format!("routing-{label}"),
                        &format!("Partitioning {label}: {} segments", state.ids[mode]),
                        state.ways,
                        state.totals[mode],
                        "ways",
                        3 + mode * 2,
                    );
                }
            }
            state.stage += 1;
            state.commit(&db)?;
        }
        if state.stage == 3 + mode * 2 {
            let remaining: u64 = db.query_row(
                "SELECT count(*) FROM (SELECT cell FROM edges WHERE mode=? GROUP BY cell)",
                [mode as u32],
                |r| r.get(0),
            )?;
            let total = state.counts[mode][0] + remaining;
            let mut progress = Progress::new(state.counts[mode][0]);
            progress.report(
                &format!("routing-{label}-cells"),
                &format!("Encoding {label} routing cells"),
                state.counts[mode][0],
                total,
                "cells",
                4 + mode * 2,
            );
            let mut last = -1i64;
            loop {
                let address: Option<i64> = db.query_row(
                    "SELECT min(cell) FROM edges WHERE mode=? AND cell>?",
                    params![mode as u32, last],
                    |r| r.get(0),
                )?;
                let Some(address) = address else { break };
                last = address;
                let mut graph_nodes = Vec::new();
                let mut lookup = HashMap::new();
                let mut segments = Vec::new();
                let mut costs = Vec::new();
                let mut cell_ids = Vec::new();
                let mut stmt=db.prepare("SELECT id,a,b,way,flags,ax,ay,bx,by,c0,c1 FROM edges WHERE mode=? AND cell=? ORDER BY id")?;
                let mut rows = stmt.query(params![mode as u32, address])?;
                while let Some(r) = rows.next()? {
                    if segments.len() >= 300_000 {
                        return Err("Routing cell exceeds 300,000 segments".into());
                    }
                    let mut node = |id: i64, position: [f64; 2]| -> u32 {
                        *lookup.entry(id).or_insert_with(|| {
                            let n = graph_nodes.len() as u32;
                            graph_nodes.push(Node { id, position });
                            n
                        })
                    };
                    let a = node(r.get(1)?, [r.get(5)?, r.get(6)?]);
                    let b = node(r.get(2)?, [r.get(7)?, r.get(8)?]);
                    segments.push(Segment {
                        a,
                        b,
                        way: r.get(3)?,
                        directions: r.get(4)?,
                    });
                    // Preserve f64 until RTE2 encoding, which rounds costs upward.
                    costs.push([r.get::<_, f64>(9)?, r.get::<_, f64>(10)?]);
                    cell_ids.push(r.get::<_, u32>(0)?);
                }
                let mut turns = Vec::new();
                for n in &graph_nodes {
                    let mut stmt = db.prepare_cached(
                        "SELECT f,t,kind FROM turns WHERE mode=? AND via=? ORDER BY f,t,kind",
                    )?;
                    for t in stmt.query_map(params![mode as u32, n.id], |r| {
                        Ok(Turn {
                            via: n.id,
                            from: r.get(0)?,
                            to: r.get(1)?,
                            kind: r.get(2)?,
                        })
                    })? {
                        turns.push(t?);
                    }
                }
                turns.sort_by_key(|t| (t.via, t.from, t.to, t.kind));
                if turns.len() > 50_000 {
                    return Err("Routing cell exceeds turn-rule limit".into());
                }
                state.counts[mode][1] += graph_nodes.len() as u64;
                state.counts[mode][2] += segments.len() as u64;
                state.counts[mode][3] += turns.len() as u64;
                let graph =
                    Graph::new(graph_nodes, segments)?.with_costs(mode as u32, costs, turns)?;
                let (x, y) = ((address / 16384) as u32, (address % 16384) as u32);
                let cell = Cell::new((x, y), graph, cell_ids)?;
                let mut zipped =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                zipped.write_all(&cell.encode())?;
                db.execute(
                    "INSERT INTO cells VALUES(?,?,?)",
                    params![mode as u32, address, zipped.finish()?],
                )?;
                db.execute(
                    "DELETE FROM edges WHERE mode=? AND cell=?",
                    params![mode as u32, address],
                )?;
                state.counts[mode][0] += 1;
                if progress.due() {
                    state.commit(&db)?;
                    progress.report(
                        &format!("routing-{label}-cells"),
                        &format!("Encoding {label} routing cells"),
                        state.counts[mode][0],
                        total,
                        "cells",
                        4 + mode * 2,
                    );
                }
            }
            state.stage += 1;
            state.ways = 0;
            state.offset = state.first_way.unwrap_or(source_bytes);
            state.commit(&db)?;
        }
    }
    let mut output = BufWriter::new(std::io::stdout().lock());
    let mut metadata = serde_json::Map::new();
    let mut progress = Progress::new(0);
    let total = state.counts.iter().map(|c| c[0]).sum();
    let mut emitted = 0;
    for mode in 0..3 {
        let mut stmt = db.prepare("SELECT cell,data FROM cells WHERE mode=? ORDER BY cell")?;
        let mut rows = stmt.query([mode as u32])?;
        while let Some(row) = rows.next()? {
            let address: i64 = row.get(0)?;
            let compressed: Vec<u8> = row.get(1)?;
            let mut bytes = Vec::new();
            flate2::read::GzDecoder::new(&compressed[..]).read_to_end(&mut bytes)?;
            let (x, y) = (address / 16384, address % 16384);
            frame(
                &mut output,
                &format!("routing/{}/cells/14/{x}/{y}", transport::MODES[mode]),
                &bytes,
            )?;
            emitted += 1;
            if progress.due() {
                progress.report(
                    "routing-output",
                    "Packing saved routing cells",
                    emitted,
                    total,
                    "cells",
                    8,
                );
            }
        }
        let excluded: u64 = db.query_row(
            "SELECT count(*) FROM excluded WHERE mode=?",
            [mode as u32],
            |r| r.get(0),
        )?;
        let c = state.counts[mode];
        metadata.insert(transport::MODES[mode].into(),json!({"count":c[0],"nodes":c[1],"segments":c[2],"turns":c[3],"canonicalSegments":state.ids[mode],"skippedWays":state.skipped[mode],"unsupportedRestrictions":state.unsupported[mode],"excludedRestrictionWays":excluded}));
    }
    frame(&mut output, "metadata", &serde_json::to_vec(&metadata)?)?;
    output.flush()?;
    db.execute_batch("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(())
}
