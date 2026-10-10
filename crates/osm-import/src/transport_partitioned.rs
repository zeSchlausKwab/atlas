//! Construct RCL2 directly, one cell at a time. The complete graph never exists in RAM.
//! Segment IDs follow the canonical source-way order, exactly like the regional importer.
use crate::{
    node_store::NodeWriter,
    transport,
    transport_import::{restriction, turn_kind},
};
use atlas_routing::{
    cells::{cell, Cell},
    distance, Graph, Node, Segment, Turn,
};
use osmpbfreader::{OsmId, OsmObj, OsmPbfReader};
use rusqlite::{params, Connection};
use serde_json::json;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufWriter, Write},
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
    let path = Path::new(work).join("routing-spool.sqlite");
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let db = Connection::open(&path)?;
    db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-65536; PRAGMA mmap_size=0;
        CREATE TABLE excluded(mode INTEGER,way INTEGER,PRIMARY KEY(mode,way)) WITHOUT ROWID;
        CREATE TABLE turns(mode INTEGER,via INTEGER,f INTEGER,t INTEGER,kind INTEGER,PRIMARY KEY(mode,via,f,t,kind)) WITHOUT ROWID;
        CREATE TABLE edges(mode INTEGER,cell INTEGER,id INTEGER,a INTEGER,b INTEGER,way INTEGER,flags INTEGER,ax REAL,ay REAL,bx REAL,by REAL,c0 REAL,c1 REAL,PRIMARY KEY(mode,cell,id)) WITHOUT ROWID;
        BEGIN;")?;
    let mut reader = OsmPbfReader::new(File::open(source)?);
    let mut nodes = NodeWriter::new()?;
    let mut unsupported = [0u64; 3];
    let mut objects = 0u64;
    for object in reader.iter() {
        match object? {
            OsmObj::Node(n) => nodes.push(
                n.id,
                [n.decimicro_lon, n.decimicro_lat],
                std::array::from_fn(|mode| transport::blocked(&n.tags, mode)),
            )?,
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
                    let conditional = r
                        .tags
                        .keys()
                        .any(|k| k.starts_with("restriction") && k.ends_with(":conditional"));
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
                    if conditional || !known || node.is_none() || from.len() != 1 || to.len() != 1 {
                        unsupported[mode] += 1;
                        for way in from {
                            db.prepare_cached("INSERT OR IGNORE INTO excluded VALUES(?,?)")?
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
        objects += 1;
        if objects % 10_000_000 == 0 {
            eprintln!("Coordinate/restriction scan: {objects} objects");
        }
    }
    db.execute_batch("COMMIT")?;
    let nodes = nodes.finish()?;
    let mut ids = [0u64; 3];
    let mut skipped = [0u64; 3];
    let mut output = BufWriter::new(std::io::stdout().lock());
    let mut metadata = serde_json::Map::new();
    // Reuse disk pages between profiles instead of retaining three complete spools.
    for mode in 0usize..3 {
        db.execute_batch("BEGIN;")?;
        reader.rewind()?;
        let mut ways = 0u64;
        for object in reader.iter() {
            if let OsmObj::Way(w) = object? {
                let modes: Vec<_> = [mode]
                    .into_iter()
                    .filter(|mode| transport::directions(&w.tags, *mode) != 0)
                    .collect();
                if modes.is_empty() {
                    continue;
                }
                let coordinates: Option<Vec<_>> = w.nodes.iter().map(|id| nodes.get(id)).collect();
                for mode in modes {
                    let directions = transport::directions(&w.tags, mode);
                    if directions == 0
                        || db
                            .prepare_cached("SELECT 1 FROM excluded WHERE mode=? AND way=?")?
                            .exists(params![mode as u32, w.id.0])?
                    {
                        continue;
                    }
                    let Some(coords) = &coordinates else {
                        skipped[mode] += 1;
                        continue;
                    };
                    let speeds = transport::speeds(&w.tags, mode);
                    for (i, pair) in w.nodes.windows(2).enumerate() {
                        let (a, b) = (coords[i], coords[i + 1]);
                        if pair[0] == pair[1] || a.1[mode] || b.1[mode] {
                            continue;
                        }
                        let id = u32::try_from(ids[mode])
                            .map_err(|_| "RCL2 segment identity space exhausted")?;
                        ids[mode] += 1;
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
                                .execute(params![
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
                                ])?;
                            }
                        }
                    }
                }
                ways += 1;
                if ways % 100_000 == 0 {
                    db.execute_batch("COMMIT; BEGIN;")?;
                    eprintln!("Partitioning graph: {ways} ways; {:?} segments", ids);
                }
            }
        }
        db.execute_batch("COMMIT")?;
        let mut cells = 0u64;
        let mut node_count = 0u64;
        let mut edge_count = 0u64;
        let mut turn_count = 0u64;
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
            node_count += graph_nodes.len() as u64;
            edge_count += segments.len() as u64;
            turn_count += turns.len() as u64;
            let graph = Graph::new(graph_nodes, segments)?.with_costs(mode as u32, costs, turns)?;
            let (x, y) = ((address / 16384) as u32, (address % 16384) as u32);
            let cell = Cell::new((x, y), graph, cell_ids)?;
            frame(
                &mut output,
                &format!(
                    "routing/{}/cells/14/{x}/{y}",
                    transport::MODES[mode as usize]
                ),
                &cell.encode(),
            )?;
            cells += 1;
            if cells % 1000 == 0 {
                eprintln!("{}: wrote {cells} cells", transport::MODES[mode as usize]);
            }
        }
        let excluded: u64 = db.query_row(
            "SELECT count(*) FROM excluded WHERE mode=?",
            [mode as u32],
            |r| r.get(0),
        )?;
        metadata.insert(transport::MODES[mode as usize].into(),json!({"count":cells,"nodes":node_count,"segments":edge_count,"turns":turn_count,"canonicalSegments":ids[mode as usize],"skippedWays":skipped[mode as usize],"unsupportedRestrictions":unsupported[mode as usize],"excludedRestrictionWays":excluded}));
        db.execute_batch("DELETE FROM edges;")?;
    }
    drop(nodes);
    frame(&mut output, "metadata", &serde_json::to_vec(&metadata)?)?;
    output.flush()?;
    drop(db);
    std::fs::remove_file(path)?;
    Ok(())
}
