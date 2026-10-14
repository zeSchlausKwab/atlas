//! Disk-backed semantic source. No continent-sized feature, relation, or member-way collection.
use crate::{
    areas, display,
    graph_checkpoint::{next_block, seek},
    node_store::{NodeStore, NodeWriter},
    source_checkpoint::{discard_legacy, Progress, State},
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use osmpbfreader::blocks;
use osmpbfreader::{NodeId, OsmId, OsmObj, Relation, RelationId, WayId};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, io::Seek, path::Path};
type Error = Box<dyn std::error::Error>;
fn pack(value: &impl Serialize) -> Result<Vec<u8>, Error> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    serde_json::to_writer(&mut encoder, value)?;
    Ok(encoder.finish()?)
}
fn unpack<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, Error> {
    Ok(serde_json::from_reader(GzDecoder::new(bytes))?)
}
fn put_feature(db: &Connection, feature: &Value) -> Result<(), Error> {
    fn bounds(v: &Value, b: &mut [f64; 4]) {
        if let Some(a) = v.as_array() {
            if a.len() >= 2 && a[0].is_number() {
                let x = a[0].as_f64().unwrap();
                let y = a[1].as_f64().unwrap();
                b[0] = b[0].min(x);
                b[1] = b[1].min(y);
                b[2] = b[2].max(x);
                b[3] = b[3].max(y);
            } else {
                for c in a {
                    bounds(c, b);
                }
            }
        }
    }
    let mut b = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    bounds(&feature["geometry"]["coordinates"], &mut b);
    let lon = (b[0] + b[2]) / 2.;
    let lat = ((b[1] + b[3]) / 2.).clamp(-85., 85.).to_radians();
    let x = (((lon + 180.) / 360. * 512.).floor() as i64).clamp(0, 511);
    let y = (((1. - (lat.tan() + 1. / lat.cos()).ln() / std::f64::consts::PI) / 2. * 512.).floor()
        as i64)
        .clamp(0, 511);
    let id = feature["properties"]["id"]
        .as_str()
        .ok_or("Missing feature ID")?;
    db.prepare_cached("INSERT INTO features VALUES(?,?,?,?)")?
        .execute(params![
            id,
            feature["properties"]["class"].as_i64(),
            pack(feature)?,
            x * 512 + y
        ])?;
    Ok(())
}
fn load_relations(
    db: &Connection,
    id: RelationId,
    depth: usize,
    loaded: &mut HashMap<RelationId, Relation>,
    bytes: &mut usize,
) -> Result<(), Error> {
    if depth >= 32 || loaded.len() >= 100000 {
        return Err("Area relation nesting limit".into());
    }
    if loaded.contains_key(&id) {
        return Ok(());
    } // flatten diagnoses cycles with role/path semantics.
    let data: Option<Vec<u8>> = db
        .query_row("SELECT data FROM relations WHERE id=?", [id.0], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(data) = data else {
        return Ok(());
    };
    *bytes += data.len();
    if *bytes > 64 * 1024 * 1024 {
        return Err("Area relation working set exceeds 64 MiB".into());
    }
    let relation: Relation = unpack(&data)?;
    let children: Vec<_> = relation
        .refs
        .iter()
        .filter_map(|r| {
            if let OsmId::Relation(id) = r.member {
                Some(id)
            } else {
                None
            }
        })
        .collect();
    loaded.insert(id, relation);
    for child in children {
        load_relations(db, child, depth + 1, loaded, bytes)?;
    }
    Ok(())
}
fn create_store(output: &str) -> Result<Connection, Error> {
    let db = Connection::open(output)?;
    let initialized: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_checkpoint')",
        [],
        |r| r.get(0),
    )?;
    db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA cache_size=-65536; PRAGMA mmap_size=0; BEGIN IMMEDIATE;")?;
    if initialized {
        return Ok(db);
    }
    db.execute_batch("CREATE TABLE IF NOT EXISTS features(id TEXT PRIMARY KEY,class INTEGER,data BLOB,cell INTEGER);
      CREATE TABLE IF NOT EXISTS locations(id INTEGER PRIMARY KEY,x REAL,y REAL,category TEXT,kind TEXT,json TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS places USING rtree(id,x0,x1,y0,y1);
      CREATE TABLE IF NOT EXISTS peaks(id INTEGER PRIMARY KEY,json TEXT);
      CREATE TABLE IF NOT EXISTS relations(id INTEGER PRIMARY KEY,class INTEGER,data BLOB);
      CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY,data BLOB);
      CREATE TABLE IF NOT EXISTS outer_classes(id TEXT PRIMARY KEY,class INTEGER) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,json TEXT) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS source_checkpoint(id INTEGER PRIMARY KEY,state TEXT);")?;
    Ok(db)
}
pub fn import(source: &str, output: &str) -> Result<(), Error> {
    discard_legacy(output)?;
    let db = create_store(output)?;
    let mut state = State::open(&db, source)?;
    state.commit(&db)?;
    let source_bytes = std::fs::metadata(source)?.len();
    let node_path = format!("{output}.coordinates");
    if state.stage == 0 {
        let mut nodes = NodeWriter::resume(Path::new(&node_path), state.coordinates)?;
        let mut reader = seek(source, state.offset)?;
        let mut progress = Progress::new(state.offset);
        progress.report(
            "source-references",
            "Reading source coordinates and relations",
            state.offset,
            source_bytes,
            "bytes",
        );
        loop {
            let start = reader.stream_position()?;
            let Some(block) = next_block(&mut reader)? else {
                break;
            };
            for obj in blocks::iter(&block) {
                state.objects += 1;
                if matches!(&obj, OsmObj::Way(_)) && state.first_way.is_none() {
                    state.first_way = Some(start);
                }
                let object_id = obj.id();
                let result = (|| -> Result<(), Error> {
                    match obj {
                        OsmObj::Node(node) => {
                            let p = [node.lon(), node.lat()];
                            nodes.push(
                                node.id,
                                [node.decimicro_lon, node.decimicro_lat],
                                [false; 3],
                            )?;
                            if let Some(location) = display::node_location(&node) {
                                db.prepare_cached("INSERT INTO locations VALUES(?,?,?,?,?,?)")?
                                    .execute(params![
                                        node.id.0,
                                        p[0],
                                        p[1],
                                        location["category"].as_str(),
                                        location["kind"].as_str(),
                                        location.to_string()
                                    ])?;
                                if location["kind"] == "place"
                                    && ["city", "town", "village", "hamlet"]
                                        .contains(&location["category"].as_str().unwrap_or(""))
                                {
                                    db.prepare_cached("INSERT INTO places VALUES(?,?,?,?,?)")?
                                        .execute(params![node.id.0, p[0], p[0], p[1], p[1]])?;
                                }
                            }
                            if node.tags.get("natural").map(|v| v.as_str()) == Some("peak") {
                                let elevation = node
                                    .tags
                                    .get("ele")
                                    .and_then(|v| display::parse_elevation(v));
                                let peak = json!({"id":format!("node/{}",node.id.0),"name":node.tags.get("name").map(|v|v.as_str()).unwrap_or("Unnamed peak"),"coordinates":p,"elevation":elevation});
                                db.prepare_cached("INSERT INTO peaks VALUES(?,?)")?
                                    .execute(params![node.id.0, peak.to_string()])?;
                                put_feature(
                                    &db,
                                    &json!({"type":"Feature","geometry":{"type":"Point","coordinates":p},"properties":{"id":format!("node/{}",node.id.0),"class":7,"name":node.tags.get("name").map(|v|v.as_str()),"elevation":elevation}}),
                                )?;
                            }
                        }
                        OsmObj::Relation(r)
                            if r.tags.get("type").map(|v| v.as_str()) == Some("multipolygon") =>
                        {
                            for member in &r.refs {
                                if let OsmId::Way(id) = member.member {
                                    db.prepare_cached(
                                        "INSERT OR IGNORE INTO members(id) VALUES(?)",
                                    )?
                                    .execute([id.0])?;
                                }
                            }
                            db.prepare_cached("INSERT INTO relations VALUES(?,?,?)")?
                                .execute(params![r.id.0, areas::class(&r.tags), pack(&r)?])?;
                        }
                        _ => {}
                    }
                    Ok(())
                })();
                result.map_err(|e| format!("Source references {object_id:?}: {e}"))?;
            }
            state.offset = reader.stream_position()?;
            if progress.due() {
                state.coordinates = nodes.checkpoint()?;
                state.commit(&db)?;
                progress.report(
                    "source-references",
                    &format!(
                        "Source coordinates and relations: {} objects",
                        state.objects
                    ),
                    state.offset,
                    source_bytes,
                    "bytes",
                );
            }
        }
        state.coordinates = nodes.checkpoint()?;
        state.stage = 1;
        state.offset = state.first_way.unwrap_or(source_bytes);
        state.commit(&db)?;
    }
    if state.stage <= 2 {
        // Also truncate any append made before the last durable coordinate cursor.
        drop(NodeWriter::resume(
            Path::new(&node_path),
            state.coordinates,
        )?);
        let nodes = NodeStore::open(Path::new(&node_path), state.coordinates)?;
        if state.stage == 1 {
            let mut reader = seek(source, state.offset)?;
            let first = state.first_way.unwrap_or(source_bytes);
            let mut progress = Progress::new(state.offset - first);
            progress.report(
                "source-ways",
                "Building source geometry",
                state.offset - first,
                source_bytes - first,
                "bytes",
            );
            while let Some(block) = next_block(&mut reader)? {
                for way in blocks::ways(&block) {
                    state.ways += 1;
                    let result = (|| -> Result<(), Error> {
                        let member: bool = db
                            .prepare_cached("SELECT EXISTS(SELECT 1 FROM members WHERE id=?)")?
                            .query_row([way.id.0], |r| r.get(0))?;
                        if member {
                            db.prepare_cached("UPDATE members SET data=? WHERE id=?")?
                                .execute(params![pack(&way.nodes)?, way.id.0])?;
                        }
                        match display::way_feature(&way, &nodes) {
                            Ok(Some(f)) => put_feature(&db, &f)?,
                            Ok(None) => {}
                            Err(()) => state.skipped_ways += 1,
                        }
                        Ok(())
                    })();
                    result.map_err(|e| {
                        format!(
                            "Source geometry way {} (way {} in pass): {e}",
                            way.id.0, state.ways
                        )
                    })?;
                }
                state.offset = reader.stream_position()?;
                if progress.due() {
                    state.commit(&db)?;
                    progress.report(
                        "source-ways",
                        &format!("Source geometry: {} ways", state.ways),
                        state.offset - first,
                        source_bytes - first,
                        "bytes",
                    );
                }
            }
            state.stage = 2;
            state.commit(&db)?;
        }
        let total: u64 = db.query_row(
            "SELECT count(*) FROM relations WHERE class IS NOT NULL",
            [],
            |r| r.get(0),
        )?;
        let mut progress = Progress::new(state.relations);
        progress.report(
            "source-areas",
            "Assembling source multipolygons",
            state.relations,
            total,
            "objects",
        );
        loop {
            let next: Option<i64> = db.query_row(
                "SELECT min(id) FROM relations WHERE id>? AND class IS NOT NULL",
                [state.last_relation],
                |r| r.get(0),
            )?;
            let Some(id) = next else { break };
            state.last_relation = id;
            state.relations += 1;
            let result = (|| -> Result<(), Error> {
                let mut relations = HashMap::new();
                load_relations(&db, RelationId(id), 0, &mut relations, &mut 0)?;
                let root = relations.get(&RelationId(id)).ok_or("Missing area root")?;
                let class = areas::class(&root.tags).unwrap();
                let relation = match areas::flatten(root, &relations) {
                    Ok(r) => r,
                    Err(_) => {
                        state.skipped += 1;
                        return Ok(());
                    }
                };
                drop(relations);
                let mut members: HashMap<WayId, Vec<NodeId>> = HashMap::new();
                let mut points = 0usize;
                for r in &relation.refs {
                    if let OsmId::Way(id) = r.member {
                        let data: Option<Vec<u8>> = db
                            .query_row("SELECT data FROM members WHERE id=?", [id.0], |r| r.get(0))
                            .optional()?
                            .flatten();
                        if let Some(data) = data {
                            let ids: Vec<NodeId> = unpack(&data)?;
                            points += ids.len();
                            if points > 3000000 {
                                return Err("Area relation exceeds 3 million member points".into());
                            }
                            members.insert(id, ids);
                        }
                    }
                }
                match areas::assemble(&relation, &members, &|id| nodes.get(id).map(|n| n.0)) {
                    Ok(coordinates) => {
                        for r in &relation.refs {
                            if r.role == "outer" || r.role.is_empty() {
                                if let OsmId::Way(id) = r.member {
                                    db.prepare_cached("INSERT INTO outer_classes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET class=excluded.class")?
                                .execute(params![format!("way/{}", id.0), class])?;
                                }
                            }
                        }
                        let tags: serde_json::Map<String, Value> = relation
                            .tags
                            .iter()
                            .map(|(k, v)| (k.to_string(), json!(v.as_str())))
                            .collect();
                        put_feature(
                            &db,
                            &json!({"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":coordinates},"properties":{"id":format!("relation/{id}"),"class":class,"name":relation.tags.get("name").map(|v|v.as_str()).unwrap_or(""),"tags":tags}}),
                        )?;
                        state.assembled += 1;
                    }
                    Err(_) => state.skipped += 1,
                }
                Ok(())
            })();
            result.map_err(|e| format!("Source area relation {id}: {e}"))?;
            if progress.due() {
                state.commit(&db)?;
                progress.report(
                    "source-areas",
                    &format!(
                        "Source areas: {} assembled, {} skipped",
                        state.assembled, state.skipped
                    ),
                    state.relations,
                    total,
                    "objects",
                );
            }
        }
        state.stage = 3;
        state.commit(&db)?;
    }
    // Coordinates are no longer needed once area assembly has committed.
    if Path::new(&node_path).exists() {
        std::fs::remove_file(&node_path)?;
    }
    if state.stage == 3 {
        let remaining: u64 =
            db.query_row("SELECT count(*) FROM outer_classes", [], |r| r.get(0))?;
        let total = state.pruned + remaining;
        let mut progress = Progress::new(state.pruned);
        loop {
            let ids: Vec<String> = db
                .prepare("SELECT id FROM outer_classes ORDER BY id LIMIT 10000")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            let Some(last) = ids.last() else {
                break;
            };
            for id in &ids {
                db.prepare_cached("DELETE FROM features WHERE id=?1 AND class=(SELECT class FROM outer_classes WHERE id=?1)")?.execute([id])?;
            }
            db.execute("DELETE FROM outer_classes WHERE id<=?", [last])?;
            state.pruned += ids.len() as u64;
            state.commit(&db)?;
            progress.report(
                "source-pruning",
                "Removing duplicate outer geometries",
                state.pruned,
                total,
                "objects",
            );
        }
        state.stage = 4;
        state.commit(&db)?;
    }
    let mut progress = Progress::new(0);
    let steps = [
        (
            "Removing temporary source relations",
            "DROP TABLE outer_classes; DROP TABLE members; DROP TABLE relations;",
        ),
        (
            "Indexing source geometry cells",
            "CREATE INDEX feature_cells ON features(cell)",
        ),
    ];
    while state.stage < 6 {
        let (message, sql) = steps[state.stage - 4];
        progress.report(
            "source-finalization",
            message,
            (state.stage - 4) as u64,
            2,
            "blocks",
        );
        db.execute_batch(sql)
            .map_err(|e| format!("{message}: {e}"))?;
        state.stage += 1;
        state.commit(&db)?;
    }
    if state.stage == 6 {
        progress.report(
            "source-validation",
            "Checking source database integrity",
            0,
            0,
            "blocks",
        );
        let check: String = db.query_row("PRAGMA quick_check(1)", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(format!("Source database integrity check failed: {check}").into());
        }
        let stats = json!({"schema":"source-store-v1","skippedWays":state.skipped_ways,"assembledRelations":state.assembled,"skippedRelations":state.skipped});
        db.execute(
            "INSERT INTO metadata VALUES('stats',?)",
            [stats.to_string()],
        )?;
        state.stage = 7;
        state.commit(&db)?;
        eprintln!("Source store complete: {stats}");
    }
    db.execute_batch("COMMIT;")?;
    drop(db);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_transaction_preserves_committed_source_geometry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.sqlite");
        let db = create_store(path.to_str().unwrap()).unwrap();
        db.execute_batch("PRAGMA cache_size=4").unwrap();
        for i in 0..1000 {
            db.execute(
                "INSERT INTO features VALUES(?,1,zeroblob(1200),0)",
                [format!("saved/{i}")],
            )
            .unwrap();
        }
        db.execute_batch("COMMIT; BEGIN IMMEDIATE").unwrap();
        // Force dirty pages to spill, then drop an unfinished transaction as on a failure.
        for i in 0..1000 {
            db.execute(
                "UPDATE features SET data=zeroblob(12000),class=2 WHERE id=?",
                [format!("saved/{i}")],
            )
            .unwrap();
        }
        drop(db);
        let db = Connection::open(path).unwrap();
        let check: String = db
            .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
            .unwrap();
        assert_eq!(check, "ok");
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM features WHERE class=1 AND length(data)=1200",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1000, "uncommitted geometry must be rolled back");
    }
}
