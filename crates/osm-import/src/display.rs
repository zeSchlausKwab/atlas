use crate::{areas, node_store::NodeWriter, walking};
use atlas_routing::{Graph, Node, Segment};
use osmpbfreader::{OsmId, OsmObj, OsmPbfReader};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{BufWriter, Write},
};

pub fn import(
    source: &str,
    output: &str,
    legacy_routing: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut reader = OsmPbfReader::new(File::open(source)?);
    let mut nodes = NodeWriter::new()?;
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
    // Coordinates live on disk; feature/relationship state is bounded by the input partition.
    for object in reader.iter() {
        let object = object?;
        if let OsmObj::Relation(relation) = &object {
            if matches!(
                relation.tags.get("type").map(|v| v.as_str()),
                Some("multipolygon" | "boundary")
            ) {
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
            nodes.push(
                node.id,
                [node.decimicro_lon, node.decimicro_lat],
                [false; 3],
            )?;
            if let Some(location) = node_location(&node) {
                locations.push(location);
            }
            if legacy_routing && walking::node_blocked(&node.tags) {
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
    let nodes = nodes.finish()?;
    reader.rewind()?;
    for object in reader.iter() {
        if let OsmObj::Way(way) = object? {
            if member_ids.contains(&way.id) {
                member_ways.insert(way.id, way.nodes.clone());
            }
            let directions = walking::directions(&way.tags);
            if legacy_routing && directions != 0 {
                if way.nodes.iter().any(|id| !nodes.contains_key(id)) {
                    routing_skipped_ways += 1;
                } else {
                    for pair in way.nodes.windows(2) {
                        let (a, b) = (pair[0], pair[1]);
                        // Remove both incident segments at a blocked node; never bridge over it.
                        if a == b || blocked_nodes.contains(&a) || blocked_nodes.contains(&b) {
                            continue;
                        }
                        graph_nodes.insert(a, nodes.get(&a).unwrap().0);
                        graph_nodes.insert(b, nodes.get(&b).unwrap().0);
                        graph_segments.push((a, b, way.id.0, directions));
                    }
                }
            }
            match way_feature(&way, &nodes) {
                Ok(Some(feature)) => features.push(feature),
                Ok(None) => {}
                Err(()) => skipped_ways += 1,
            }
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
        let boundary_refs = areas::place_members(relation);
        let relation = match areas::flatten(relation, &relations) {
            Ok(r) => r,
            Err(_) => {
                skipped_relations += 1;
                continue;
            }
        };
        match areas::assemble(&relation, &member_ways, &|id| nodes.get(id).map(|n| n.0)) {
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
                features.push(json!({"type":"Feature","geometry":{"type":"MultiPolygon","coordinates":coordinates},"properties":{"id":format!("relation/{}",relation.id.0),"class":class,"boundaryRefs":boundary_refs,"name":relation.tags.get("name").map(|v|v.as_str()).unwrap_or(""),"tags":tags}}));
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

pub(crate) fn parse_elevation(value: &str) -> Option<f64> {
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
    fn location(tags: &[(&str, &str)]) -> Value {
        let node = osmpbfreader::Node {
            id: osmpbfreader::NodeId(42),
            decimicro_lat: 480000000,
            decimicro_lon: 160000000,
            tags: tags
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
        };
        node_location(&node).unwrap()
    }
    #[test]
    fn semantic_nodes_keep_explicit_addresses_and_unnamed_pois() {
        let address = location(&[
            ("addr:housenumber", "12B"),
            ("addr:street", "Testgasse"),
            ("addr:city", "Wien"),
        ]);
        assert_eq!(address["kind"], "address");
        assert_eq!(address["name"], "Testgasse 12B Wien");
        assert_eq!(address["tags"]["addr:housenumber"], "12B");
        let poi = location(&[("amenity", "cafe"), ("wheelchair", "yes")]);
        assert_eq!(poi["kind"], "poi");
        assert_eq!(poi["tags"]["wheelchair"], "yes");
        assert!(poi["tags"].get("opening_hours").is_none());
    }
    #[test]
    fn semantic_only_polygons_survive_without_a_display_class() {
        let tags = [("amenity", "school")]
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        assert_eq!(areas::class(&tags), Some(8));
    }
    #[test]
    fn elevations_are_numeric_and_unit_aware() {
        assert_eq!(parse_elevation("2599 m"), Some(2599.0));
        assert_eq!(parse_elevation("8000 ft"), None);
        assert_eq!(parse_elevation("2599mm"), None);
        assert_eq!(parse_elevation("NaN"), None);
    }
}

pub(crate) fn node_location(node: &osmpbfreader::Node) -> Option<Value> {
    let tag = |key: &str| node.tags.get(key).map(|s| s.as_str()).unwrap_or("").trim();
    let number = tag("addr:housenumber");
    let category = [
        "place",
        "amenity",
        "tourism",
        "shop",
        "historic",
        "public_transport",
        "leisure",
        "office",
        "craft",
        "healthcare",
        "emergency",
    ]
    .iter()
    .map(|key| tag(key))
    .find(|v| !v.is_empty())
    .or_else(|| (tag("natural") == "peak").then_some("peak"))
    .or_else(|| {
        ["station", "halt", "tram_stop", "subway_entrance"]
            .contains(&tag("railway"))
            .then(|| tag("railway"))
    })
    .or_else(|| (tag("highway") == "bus_stop").then_some("bus_stop"));
    if category.is_none() && number.is_empty() {
        return None;
    }
    let kind = if !tag("place").is_empty() {
        "place"
    } else if tag("natural") == "peak" {
        "peak"
    } else if category.is_none() {
        "address"
    } else {
        "poi"
    };
    let address = [
        tag("addr:street"),
        tag("addr:place"),
        number,
        tag("addr:postcode"),
        tag("addr:city"),
        tag("addr:country"),
    ]
    .into_iter()
    .filter(|v| !v.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    let name = if !tag("name").is_empty() {
        tag("name")
    } else if !number.is_empty() {
        &address
    } else {
        category.unwrap_or("Unnamed POI")
    };
    let mut aliases: Vec<&str> = ["alt_name", "short_name", "name:de", "name:en"]
        .iter()
        .flat_map(|key| tag(key).split(';'))
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != name)
        .collect();
    if !number.is_empty() && address != name {
        aliases.push(&address);
    }
    aliases.sort();
    aliases.dedup();
    Some(
        json!({"id":format!("node/{}",node.id.0),"name":name,"aliases":aliases,
        "kind":kind,"category":category.unwrap_or("address"),"coordinates":[node.lon(),node.lat()], "tags":node.tags}),
    )
}

pub(crate) fn way_feature(
    way: &osmpbfreader::Way,
    nodes: &crate::node_store::NodeStore,
) -> Result<Option<Value>, ()> {
    let tag = |key: &str| way.tags.get(key).map(|v| v.as_str()).unwrap_or("");
    let highway = tag("highway");
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
        return Ok(None);
    };
    let coordinates: Option<Vec<[f64; 2]>> = way
        .nodes
        .iter()
        .map(|id| nodes.get(id).map(|n| n.0))
        .collect();
    let Some(coordinates) = coordinates else {
        return Err(());
    };
    if coordinates.len() < 2 {
        return Ok(None);
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
    Ok(Some(
        json!({"type":"Feature","geometry":geometry,"properties":{"id":format!("way/{}",way.id.0),"class":class,"name":tag("name"),"tags":tags}}),
    ))
}
