//! Construct RCL2/RCL3 directly, one cell at a time. The complete graph never exists in RAM.
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
// Acknowledged batches bound output even when the host runtime eagerly drains pipes.
// This is only the compiler IPC protocol; persisted RCL bytes and checkpoints do not change.
const OUTPUT_WINDOW: usize = 1024 * 1024;
struct RoutingOutput<W: Write, R: Read> {
    output: W,
    acknowledgments: Option<R>,
    pending: usize,
}
impl<W: Write, R: Read> RoutingOutput<W, R> {
    fn new(mut output: W, acknowledgments: Option<R>) -> Result<Self, Error> {
        if acknowledgments.is_some() {
            frame(
                &mut output,
                "protocol",
                br#"{"version":1,"windowBytes":1048576}"#,
            )?;
        }
        Ok(Self {
            output,
            acknowledgments,
            pending: 0,
        })
    }
    fn checkpoint(&mut self) -> Result<(), Error> {
        if self.pending == 0 {
            return Ok(());
        }
        if let Some(input) = &mut self.acknowledgments {
            frame(&mut self.output, "ack", &[])?;
            self.output.flush()?;
            let mut ack = [0u8; 1];
            input.read_exact(&mut ack)?;
            if ack != [1] {
                return Err("Invalid routing output acknowledgment".into());
            }
        }
        self.pending = 0;
        Ok(())
    }
    fn cell(&mut self, key: &str, bytes: &[u8]) -> Result<(), Error> {
        let size = 8 + key.len() + bytes.len();
        if self.pending > 0 && self.pending + size > OUTPUT_WINDOW {
            self.checkpoint()?;
        }
        frame(&mut self.output, key, bytes)?;
        self.pending += size;
        Ok(())
    }
    fn finish(mut self, metadata: &[u8]) -> Result<(), Error> {
        self.checkpoint()?;
        frame(&mut self.output, "metadata", metadata)?;
        self.output.flush()?;
        Ok(())
    }
}
pub fn import(source: &str, work: &str) -> Result<(), Error> {
    std::fs::create_dir_all(work)?;
    let work = Path::new(work);
    let stable_ids = std::env::var("ATLAS_ROUTING_IDS").as_deref() == Ok("osm-way-segment-v1");
    let path = work.join(if stable_ids {
        "routing-v3.sqlite"
    } else {
        "routing-v2.sqlite"
    });
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
    if stable_ids {
        let has_ordinal: bool = db
            .prepare("PRAGMA table_info(edges)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|c| c == "ordinal");
        if !has_ordinal {
            db.execute_batch("ALTER TABLE edges ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0")?;
        }
    }
    let mut state = State::open(&db, source)?;
    db.execute_batch("BEGIN IMMEDIATE")?;
    state.commit(&db)?;
    let source_bytes = std::fs::metadata(source)?.len();
    let needed_path = work.join(if stable_ids {
        "routing-v3-needed.bits"
    } else {
        "routing-needed.bits"
    });
    let node_path = work.join(if stable_ids {
        "routing-v3-coordinates.bin"
    } else {
        "routing-coordinates.bin"
    });
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
                                let id = i64::try_from(state.ids[mode])?;
                                if !stable_ids && id > u32::MAX as i64 {
                                    return Err("RCL2 segment identity space exhausted".into());
                                }
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
                                            if stable_ids { "INSERT INTO edges(mode,cell,id,a,b,way,flags,ax,ay,bx,by,c0,c1,ordinal) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)" }
                                            else { "INSERT INTO edges VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)" },
                                        )?
                                        .execute(
                                            rusqlite::params_from_iter({
                                                let values: [rusqlite::types::Value; 13] = [
                                                (mode as i64).into(),
                                                ((x as i64) * 16384 + y as i64).into(),
                                                (id as i64).into(), pair[0].0.into(), pair[1].0.into(),
                                                w.id.0.into(), (directions as i64).into(),
                                                a.0[0].into(), a.0[1].into(), b.0[0].into(), b.0[1].into(),
                                                (meters / speeds[0]).into(), (meters / speeds[1]).into(),
                                                ];
                                                values.into_iter().chain(if stable_ids { Some(i64::try_from(i)?.into()) } else { None })
                                            }),
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
                let mut osm_ids = Vec::new();
                let mut stmt=db.prepare(if stable_ids {
                    "SELECT id,a,b,way,flags,ax,ay,bx,by,c0,c1,ordinal FROM edges WHERE mode=? AND cell=? ORDER BY way,ordinal"
                } else { "SELECT id,a,b,way,flags,ax,ay,bx,by,c0,c1 FROM edges WHERE mode=? AND cell=? ORDER BY id" })?;
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
                    if !stable_ids {
                        cell_ids.push(r.get::<_, u32>(0)?);
                    }
                    if stable_ids {
                        let way = r.get::<_, i64>(3)?;
                        if way <= 0 {
                            return Err("Federated routing requires positive OSM way IDs".into());
                        }
                        osm_ids.push(((way as u128) << 32) | r.get::<_, u32>(11)? as u128);
                    }
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
                let cell = if stable_ids {
                    Cell::osm((x, y), graph, osm_ids)?
                } else {
                    Cell::new((x, y), graph, cell_ids)?
                };
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
    let ack = std::env::var("ATLAS_GRAPH_OUTPUT_ACK").as_deref() == Ok("1");
    let mut output = RoutingOutput::new(
        BufWriter::new(std::io::stdout().lock()),
        if ack {
            Some(std::io::stdin().lock())
        } else {
            None
        },
    )?;
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
            output.cell(
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
    output.finish(&serde_json::to_vec(&metadata)?)?;
    db.execute_batch("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(())
}

#[cfg(test)]
mod output_tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn acknowledged_batches_preserve_payload_and_require_credit() {
        let payload = vec![7u8; OUTPUT_WINDOW / 2];
        let mut bytes = Vec::new();
        let mut output = RoutingOutput::new(&mut bytes, Some(Cursor::new(vec![1, 1]))).unwrap();
        output.cell("cell", &payload).unwrap();
        output.cell("cell", &payload).unwrap();
        output.finish(b"{}").unwrap();
        let mut input = Cursor::new(bytes);
        let mut keys = Vec::new();
        while (input.position() as usize) < input.get_ref().len() {
            let mut header = [0u8; 8];
            input.read_exact(&mut header).unwrap();
            let mut key = vec![0; u32::from_le_bytes(header[..4].try_into().unwrap()) as usize];
            let mut body = vec![0; u32::from_le_bytes(header[4..].try_into().unwrap()) as usize];
            input.read_exact(&mut key).unwrap();
            input.read_exact(&mut body).unwrap();
            let key = String::from_utf8(key).unwrap();
            if key == "cell" {
                assert_eq!(body, payload);
            }
            keys.push(key);
        }
        assert_eq!(keys, ["protocol", "cell", "ack", "cell", "ack", "metadata"]);
        for credit in [vec![], vec![0]] {
            let mut output = RoutingOutput::new(Vec::new(), Some(Cursor::new(credit))).unwrap();
            output.cell("cell", &payload).unwrap();
            assert!(output.cell("cell", &payload).is_err());
        }
    }
    #[test]
    fn standalone_stream_remains_byte_identical() {
        let mut bytes = Vec::new();
        let mut output = RoutingOutput::new(&mut bytes, None::<Cursor<Vec<u8>>>).unwrap();
        output.cell("cell", b"payload").unwrap();
        output.finish(b"{}").unwrap();
        let mut expected = Vec::new();
        frame(&mut expected, "cell", b"payload").unwrap();
        frame(&mut expected, "metadata", b"{}").unwrap();
        assert_eq!(bytes, expected);
    }
}
