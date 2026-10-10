//! Disk-backed semantic source. No continent-sized feature, relation, or member-way collection.
use crate::{areas, display, node_store::NodeWriter};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use osmpbfreader::{NodeId, OsmId, OsmObj, OsmPbfReader, Relation, RelationId, WayId};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs::File};
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
pub fn import(source: &str, output: &str) -> Result<(), Error> {
    // Unfinished stage output is scratch; the orchestrator only checkpoints a completed file.
    if std::path::Path::new(output).exists() {
        std::fs::remove_file(output)?;
    }
    let db = Connection::open(output)?;
    db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-65536; PRAGMA mmap_size=0;
      CREATE TABLE features(id TEXT PRIMARY KEY,class INTEGER,data BLOB,cell INTEGER);
      CREATE TABLE locations(id INTEGER PRIMARY KEY,x REAL,y REAL,category TEXT,kind TEXT,json TEXT);
      CREATE VIRTUAL TABLE places USING rtree(id,x0,x1,y0,y1);
      CREATE TABLE peaks(id INTEGER PRIMARY KEY,json TEXT);
      CREATE TABLE relations(id INTEGER PRIMARY KEY,class INTEGER,data BLOB);
      CREATE TABLE members(id INTEGER PRIMARY KEY,data BLOB);
      CREATE TABLE outer_classes(id TEXT PRIMARY KEY,class INTEGER) WITHOUT ROWID;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,json TEXT) WITHOUT ROWID;
      BEGIN;")?;
    let mut reader = OsmPbfReader::new(File::open(source)?);
    let mut nodes = NodeWriter::new()?;
    let mut objects = 0u64;
    for obj in reader.iter() {
        objects += 1;
        if objects % 500000 == 0 {
            db.execute_batch("COMMIT; BEGIN;")?;
            eprintln!("Source coordinates and relations: {objects} objects");
        }
        match obj? {
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
                        db.prepare_cached("INSERT OR IGNORE INTO members(id) VALUES(?)")?
                            .execute([id.0])?;
                    }
                }
                db.prepare_cached("INSERT INTO relations VALUES(?,?,?)")?
                    .execute(params![r.id.0, areas::class(&r.tags), pack(&r)?])?;
            }
            _ => {}
        }
    }
    db.execute_batch("COMMIT; BEGIN;")?;
    let nodes = nodes.finish()?;
    reader.rewind()?;
    let mut ways = 0u64;
    let mut skipped_ways = 0u64;
    for obj in reader.iter() {
        if let OsmObj::Way(way) = obj? {
            ways += 1;
            if ways % 100000 == 0 {
                db.execute_batch("COMMIT; BEGIN;")?;
                eprintln!("Source geometry: {ways} ways");
            }
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
                Err(()) => skipped_ways += 1,
            }
        }
    }
    db.execute_batch("COMMIT; BEGIN;")?;
    let mut last = -1i64;
    let mut assembled = 0u64;
    let mut skipped = 0u64;
    loop {
        let next: Option<i64> = db.query_row(
            "SELECT min(id) FROM relations WHERE id>? AND class IS NOT NULL",
            [last],
            |r| r.get(0),
        )?;
        let Some(id) = next else { break };
        last = id;
        let mut relations = HashMap::new();
        load_relations(&db, RelationId(id), 0, &mut relations, &mut 0)?;
        let root = relations.get(&RelationId(id)).ok_or("Missing area root")?;
        let class = areas::class(&root.tags).unwrap();
        let relation = match areas::flatten(root, &relations) {
            Ok(r) => r,
            Err(_) => {
                skipped += 1;
                continue;
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
                assembled += 1;
            }
            Err(_) => skipped += 1,
        }
        if (assembled + skipped) % 10000 == 0 {
            db.execute_batch("COMMIT; BEGIN;")?;
            eprintln!("Source areas: {assembled} assembled, {skipped} skipped");
        }
    }
    drop(nodes);
    db.execute_batch("COMMIT; DELETE FROM features WHERE EXISTS(SELECT 1 FROM outer_classes o WHERE o.id=features.id AND o.class=features.class); DROP TABLE outer_classes; DROP TABLE members; DROP TABLE relations; CREATE INDEX feature_cells ON features(cell);")?;
    let stats = json!({"schema":"source-store-v1","skippedWays":skipped_ways,"assembledRelations":assembled,"skippedRelations":skipped});
    db.execute(
        "INSERT INTO metadata VALUES('stats',?)",
        [stats.to_string()],
    )?;
    eprintln!("Source store complete: {stats}");
    Ok(())
}
