#[path = "../transport.rs"]
mod transport;
#[path = "../walking.rs"]
mod walking;
use atlas_routing::{distance, Graph, Node, Segment, Turn};
use osmpbfreader::{NodeId, OsmId, OsmObj, OsmPbfReader, Tags};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
};
fn tag<'a>(t: &'a Tags, k: &str) -> &'a str {
    t.get(k).map(|v| v.as_str()).unwrap_or("")
}
fn restriction(t: &Tags, mode: usize) -> Option<&str> {
    let exceptions = tag(t, "except")
        .split(';')
        .map(str::trim)
        .collect::<Vec<_>>();
    if exceptions.iter().any(|v| match mode {
        0 => *v == "foot",
        1 => ["bicycle", "vehicle"].contains(v),
        _ => ["motor_vehicle", "motorcar", "vehicle"].contains(v),
    }) {
        return None;
    }
    let relevant_condition = match mode {
        0 => !tag(t, "restriction:foot:conditional").is_empty(),
        1 => ["restriction:conditional", "restriction:bicycle:conditional"]
            .iter()
            .any(|k| !tag(t, k).is_empty()),
        _ => [
            "restriction:conditional",
            "restriction:motor_vehicle:conditional",
            "restriction:motorcar:conditional",
        ]
        .iter()
        .any(|k| !tag(t, k).is_empty()),
    };
    if relevant_condition {
        return Some("unsupported-conditional");
    }
    let specific = if mode == 0 {
        tag(t, "restriction:foot")
    } else if mode == 1 {
        tag(t, "restriction:bicycle")
    } else {
        let c = tag(t, "restriction:motorcar");
        if c.is_empty() {
            tag(t, "restriction:motor_vehicle")
        } else {
            c
        }
    };
    if !specific.is_empty() {
        Some(specific)
    } else if mode == 0 {
        None
    } else {
        let r = tag(t, "restriction");
        (!r.is_empty()).then_some(r)
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: transport-import source.osm.pbf output-directory".into());
    }
    std::fs::create_dir_all(&args[2])?;
    let mut reader = OsmPbfReader::new(File::open(&args[1])?);
    let mut nodes = HashMap::<NodeId, ([f64; 2], [bool; 3])>::new();
    let mut relations = Vec::new();
    for o in reader.iter() {
        match o? {
            OsmObj::Node(n) => {
                nodes.insert(
                    n.id,
                    (
                        [n.lon(), n.lat()],
                        [
                            transport::blocked(&n.tags, 0),
                            transport::blocked(&n.tags, 1),
                            transport::blocked(&n.tags, 2),
                        ],
                    ),
                );
            }
            OsmObj::Relation(r) if tag(&r.tags, "type") == "restriction" => relations.push(r),
            _ => {}
        }
    }
    let mut metadata = serde_json::Map::new();
    for mode in 0..3 {
        let mut turns = Vec::new();
        let mut excluded = HashSet::new();
        let mut unsupported = 0;
        for r in &relations {
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
            let conditional = r
                .tags
                .keys()
                .any(|k| k.starts_with("restriction") && k.ends_with(":conditional"));
            let node = if via.len() == 1 {
                if let OsmId::Node(n) = via[0].member {
                    Some(n.0)
                } else {
                    None
                }
            } else {
                None
            };
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
                unsupported += 1;
                excluded.extend(from);
                continue;
            }
            let kind = u8::from(value.starts_with("only_"))
                + if value.ends_with("u_turn") { 2 } else { 0 };
            turns.push(Turn {
                via: node.unwrap(),
                from: from[0],
                to: to[0],
                kind,
            });
        }
        reader.rewind()?;
        let mut used = BTreeMap::new();
        let mut segments = Vec::new();
        let mut times = Vec::new();
        let mut skipped = 0;
        for object in reader.iter() {
            if let OsmObj::Way(w) = object? {
                let directions = transport::directions(&w.tags, mode);
                if directions == 0 || excluded.contains(&w.id.0) {
                    continue;
                }
                if w.nodes.iter().any(|id| !nodes.contains_key(id)) {
                    skipped += 1;
                    continue;
                }
                let speed = transport::speeds(&w.tags, mode);
                for pair in w.nodes.windows(2) {
                    let (a, b) = (pair[0], pair[1]);
                    let (na, nb) = (nodes[&a], nodes[&b]);
                    if a == b || na.1[mode] || nb.1[mode] {
                        continue;
                    }
                    used.insert(a.0, na.0);
                    used.insert(b.0, nb.0);
                    let meters = distance(na.0, nb.0);
                    segments.push((a.0, b.0, w.id.0, directions));
                    times.push([meters / speed[0], meters / speed[1]]);
                }
            }
        }
        turns.retain(|t| used.contains_key(&t.via));
        turns.sort_by_key(|t| (t.via, t.from, t.to, t.kind));
        turns.dedup_by_key(|t| (t.via, t.from, t.to, t.kind));
        let lookup: HashMap<_, _> = used
            .keys()
            .enumerate()
            .map(|(i, id)| (*id, i as u32))
            .collect();
        let graph = Graph::new(
            used.into_iter()
                .map(|(id, position)| Node { id, position })
                .collect(),
            segments
                .into_iter()
                .map(|(a, b, way, directions)| Segment {
                    a: lookup[&a],
                    b: lookup[&b],
                    way,
                    directions,
                })
                .collect(),
        )?
        .with_costs(mode as u32, times, turns)?;
        let bytes = graph.encode();
        let name = transport::MODES[mode];
        std::fs::write(format!("{}/{name}.rte", args[2]), &bytes)?;
        metadata.insert(name.into(),json!({"nodes":graph.nodes.len(),"segments":graph.segments.len(),"turns":graph.turns.len(),"skippedWays":skipped,"unsupportedRestrictions":unsupported,"excludedRestrictionWays":excluded.len(),"bytes":bytes.len()}));
        eprintln!("{name}: {} nodes, {} segments, {} turn rules; {} unsupported relations conservatively excluded",graph.nodes.len(),graph.segments.len(),graph.turns.len(),unsupported);
    }
    std::fs::write(
        format!("{}/metadata.json", args[2]),
        serde_json::to_vec_pretty(&metadata)?,
    )?;
    Ok(())
}
