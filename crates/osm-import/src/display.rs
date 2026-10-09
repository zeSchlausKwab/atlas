use crate::{areas, walking};
use atlas_routing::{Graph, Node, Segment};
use osmpbfreader::{OsmId, OsmObj, OsmPbfReader};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{BufWriter, Write},
};

pub fn import(source: &str, output: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut reader = OsmPbfReader::new(File::open(source)?);
    let mut nodes = HashMap::new();
    let mut features: Vec<Value> = Vec::new();
    let mut peaks = Vec::new();
    let mut places = Vec::new();
    let mut locations = Vec::new();
    let mut skipped_ways = 0;
    let mut blocked_nodes = HashSet::new();
    let mut graph_segments = Vec::new();
    let mut graph_nodes = BTreeMap::new();
    let mut routing_skipped_ways = 0;
    let mut relations = HashMap::new();
    let mut member_ids = HashSet::new();
    let mut member_ways = HashMap::new();
    // Two passes bound retained state to node coordinates and selected features.
    // This prototype is intended for small regional extracts, not planet imports.
    for object in reader.iter() {
        let object = object?;
        if let OsmObj::Relation(relation) = &object {
            if relation.tags.get("type").map(|v| v.as_str()) == Some("multipolygon") {
                for member in &relation.refs {
                    if let OsmId::Way(id) = member.member {
                        member_ids.insert(id);
                    }
                }
                relations.insert(relation.id, relation.clone());
            }
        }
        if let OsmObj::Node(node) = object {
            let position = [node.lon(), node.lat()];
            nodes.insert(node.id, position);
            if let Some(name) = node.tags.get("name").filter(|name| !name.trim().is_empty()) {
                let tag = |key: &str| node.tags.get(key).map(|s| s.as_str()).unwrap_or("");
                let kind = if !tag("place").is_empty() {
                    "place"
                } else if tag("natural") == "peak" {
                    "peak"
                } else {
                    "poi"
                };
                let category = [
                    "place",
                    "amenity",
                    "tourism",
                    "shop",
                    "historic",
                    "public_transport",
                    "natural",
                ]
                .iter()
                .map(|key| tag(key))
                .find(|v| !v.is_empty());
                if let Some(category) = category {
                    let mut aliases: Vec<&str> = ["alt_name", "short_name", "name:de", "name:en"]
                        .iter()
                        .flat_map(|key| tag(key).split(';'))
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && *s != name.as_str())
                        .collect();
                    aliases.sort();
                    aliases.dedup();
                    locations.push(json!({"id":format!("node/{}",node.id.0),"name":name.trim(),"aliases":aliases,"kind":kind,"category":category,"coordinates":position}));
                }
            }
            if walking::node_blocked(&node.tags) {
                blocked_nodes.insert(node.id);
            }
            if node.tags.get("natural").map(|v| v.as_str()) == Some("peak") {
                let elevation = node.tags.get("ele").and_then(|v| parse_elevation(v));
                let peak = json!({"id": format!("node/{}", node.id.0), "name": node.tags.get("name").map(|v| v.as_str()).unwrap_or("Unnamed peak"), "coordinates": position, "elevation": elevation});
                peaks.push(peak);
                features.push(json!({"type":"Feature", "geometry":{"type":"Point","coordinates":position}, "properties":{"id":format!("node/{}",node.id.0),"class":7,"name":node.tags.get("name").map(|v|v.as_str()),"elevation":elevation}}));
            }
            if let (Some(place), Some(name)) = (node.tags.get("place"), node.tags.get("name")) {
                if ["city", "town", "village"].contains(&place.as_str()) {
                    places.push(json!({"name":name.as_str(),"coordinates":position}));
                }
            }
        }
    }
    reader.rewind()?;
    for object in reader.iter() {
        if let OsmObj::Way(way) = object? {
            if member_ids.contains(&way.id) {
                member_ways.insert(way.id, way.nodes.clone());
            }
            let tag = |key: &str| way.tags.get(key).map(|v| v.as_str()).unwrap_or("");
            let highway = tag("highway");
            let directions = walking::directions(&way.tags);
            if directions != 0 {
                if way.nodes.iter().any(|id| !nodes.contains_key(id)) {
                    routing_skipped_ways += 1;
                } else {
                    for pair in way.nodes.windows(2) {
                        let (a, b) = (pair[0], pair[1]);
                        // Remove both incident segments at a blocked node; never bridge over it.
                        if a == b || blocked_nodes.contains(&a) || blocked_nodes.contains(&b) {
                            continue;
                        }
                        graph_nodes.insert(a, nodes[&a]);
                        graph_nodes.insert(b, nodes[&b]);
                        graph_segments.push((a, b, way.id.0, directions));
                    }
                }
            }
            let closed = way.nodes.len() >= 4 && way.nodes.first() == way.nodes.last();
            let area = closed.then(|| areas::class(&way.tags)).flatten();
            let (class, polygon) = if let Some(class) = area {
                (class, true)
            } else if !highway.is_empty() {
                (
                    if [
                        "motorway",
                        "motorway_link",
                        "trunk",
                        "trunk_link",
                        "primary",
                        "primary_link",
                        "secondary",
                        "secondary_link",
                    ]
                    .contains(&highway)
                    {
                        4
                    } else if ["path", "footway", "cycleway", "steps", "bridleway", "track"]
                        .contains(&highway)
                    {
                        5
                    } else {
                        3
                    },
                    false,
                )
            } else if !tag("railway").is_empty() {
                (6, false)
            } else if !tag("waterway").is_empty() {
                (1, closed && tag("area") == "yes")
            } else {
                continue;
            };
            let coordinates: Option<Vec<[f64; 2]>> =
                way.nodes.iter().map(|id| nodes.get(id).copied()).collect();
            let Some(coordinates) = coordinates else {
                skipped_ways += 1;
                continue;
            };
            if coordinates.len() < 2 {
                continue;
            }
            let geometry = if polygon {
                json!({"type":"Polygon","coordinates":[coordinates]})
            } else {
                json!({"type":"LineString","coordinates":coordinates})
            };
            let tags: serde_json::Map<String, Value> = way
                .tags
                .iter()
                .map(|(k, v)| (k.to_string(), json!(v.as_str())))
                .collect();
            features.push(json!({"type":"Feature","geometry":geometry,"properties":{"id":format!("way/{}",way.id.0),"class":class,"name":tag("name"),"tags":tags}}));
        }
    }
    let mut assembled_relations = 0;
    let mut skipped_relations = 0;
    let mut relation_outers = HashMap::new();
    let mut area_relations: Vec<_> = relations
        .values()
        .filter(|r| areas::class(&r.tags).is_some())
        .collect();
    area_relations.sort_by_key(|r| r.id);
    for relation in area_relations {
        let class = areas::class(&relation.tags).unwrap();
        let relation = match areas::flatten(relation, &relations) {
            Ok(r) => r,
            Err(_) => {
                skipped_relations += 1;
                continue;
            }
        };
        match areas::assemble(&relation, &member_ways, &nodes) {
            Ok(coordinates) => {
                for member in &relation.refs {
                    if member.role == "outer" || member.role.is_empty() {
                        if let OsmId::Way(id) = member.member {
                            relation_outers.insert(format!("way/{}", id.0), class);
                        }
                    }
                }
                let tags: serde_json::Map<String, Value> = relation
                    .tags
                    .iter()
                    .map(|(k, v)| (k.to_string(), json!(v.as_str())))
                    .collect();
                features.push(json!({"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":coordinates},"properties":{"id":format!("relation/{}",relation.id.0),"class":class,"name":relation.tags.get("name").map(|v|v.as_str()).unwrap_or(""),"tags":tags}}));
                assembled_relations += 1;
            }
            Err(_) => skipped_relations += 1,
        }
    }
    // Do not draw a tagged outer twice, which would paint over the relation's courtyards.
    features.retain(|feature| {
        let id = feature["properties"]["id"].as_str().unwrap_or("");
        !relation_outers
            .get(id)
            .is_some_and(|class| feature["properties"]["class"].as_u64() == Some(*class as u64))
    });
    eprintln!(
        "Area relations: {} assembled, {} incomplete/unsupported skipped",
        assembled_relations, skipped_relations
    );
    drop(member_ways);
    peaks.sort_by(|a, b| {
        b["elevation"]
            .as_f64()
            .unwrap_or(f64::NEG_INFINITY)
            .total_cmp(&a["elevation"].as_f64().unwrap_or(f64::NEG_INFINITY))
    });
    let graph_lookup: HashMap<_, _> = graph_nodes
        .keys()
        .enumerate()
        .map(|(i, id)| (*id, i as u32))
        .collect();
    eprintln!(
        "Building graph: {} nodes, {} segments",
        graph_nodes.len(),
        graph_segments.len()
    );
    drop(nodes);
    drop(blocked_nodes);
    let graph = Graph::new(
        graph_nodes
            .into_iter()
            .map(|(id, position)| Node { id: id.0, position })
            .collect(),
        graph_segments
            .into_iter()
            .map(|(a, b, way, directions)| Segment {
                a: graph_lookup[&a],
                b: graph_lookup[&b],
                way,
                directions,
            })
            .collect(),
    )?;
    let routing_bytes = graph.encode();
    std::fs::write(format!("{}.routing.bin", output), &routing_bytes)?;
    let routing = json!({"profile":"walking-v1","block":"routing/walking","nodes":graph.nodes.len(),"segments":graph.segments.len(),"bytes":routing_bytes.len(),"skippedWays":routing_skipped_ways,"snapLimitMeters":150,"scope":"retained-source-extract"});
    eprintln!(
        "Walking graph: {} nodes, {} segments, {} bytes",
        graph.nodes.len(),
        graph.segments.len(),
        routing_bytes.len()
    );
    let feature_count = features.len();
    let peak_count = peaks.len();
    drop(graph);
    drop(graph_lookup);
    drop(routing_bytes);
    let mut result = json!({"routing":routing,"geojson":{"type":"FeatureCollection"},"skippedWays":skipped_ways,"assembledRelations":assembled_relations,"skippedRelations":skipped_relations});
    result["geojson"]["features"] = Value::Array(features);
    result["locations"] = Value::Array(locations);
    result["peaks"] = Value::Array(peaks);
    result["places"] = Value::Array(places);
    let mut output = BufWriter::new(File::create(output)?);
    serde_json::to_writer(&mut output, &result)?;
    output.flush()?;
    eprintln!(
        "Imported {} features, {} peaks; skipped {} ways with missing nodes",
        feature_count, peak_count, skipped_ways
    );
    Ok(())
}

fn parse_elevation(value: &str) -> Option<f64> {
    // Accept numeric metres and a single explicit m suffix. Other units stay unknown.
    let trimmed = value.trim();
    let value = trimmed
        .strip_suffix('m')
        .unwrap_or(trimmed)
        .trim()
        .parse::<f64>()
        .ok()?;
    value.is_finite().then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn elevations_are_numeric_and_unit_aware() {
        assert_eq!(parse_elevation("2599 m"), Some(2599.0));
        assert_eq!(parse_elevation("8000 ft"), None);
        assert_eq!(parse_elevation("2599mm"), None);
        assert_eq!(parse_elevation("NaN"), None);
    }
}
