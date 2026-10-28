//! Source semantics independent of display classes. References keep their original order.
use crate::node_store::NodeStore;
use osmpbfreader::{Node, OsmId, Relation, Tags, Way};
use serde_json::{json, Value};
pub fn enabled() -> bool {
    std::env::var("ATLAS_SOURCE_OBJECTS").as_deref() == Ok("1")
}
pub fn id(id: OsmId) -> String {
    match id {
        OsmId::Node(x) => format!("node/{}", x.0),
        OsmId::Way(x) => format!("way/{}", x.0),
        OsmId::Relation(x) => format!("relation/{}", x.0),
    }
}
fn base(id: String, tags: &Tags, geometry: Value, status: &str) -> Value {
    json!({"id":id,"tags":tags,"geometry":geometry,"geometryStatus":status})
}
pub fn node(n: &Node) -> Option<Value> {
    (!n.tags.is_empty()).then(|| {
        base(
            format!("node/{}", n.id.0),
            &n.tags,
            json!({"type":"Point","coordinates":[n.lon(),n.lat()]}),
            "complete",
        )
    })
}
/// Closed does not imply area: retain unfamiliar closed ways as lines until their semantics are known.
fn is_area(t: &Tags) -> bool {
    let get = |k: &str| t.get(k).map(|v| v.as_str()).unwrap_or("");
    if get("area") == "no" || get("natural") == "coastline" {
        return false;
    }
    if get("area") == "yes" {
        return true;
    }
    [
        "building",
        "building:part",
        "landuse",
        "amenity",
        "leisure",
        "tourism",
        "shop",
        "office",
        "healthcare",
        "boundary",
    ]
    .iter()
    .any(|k| !get(k).is_empty())
        || [
            "water",
            "wood",
            "scrub",
            "grassland",
            "heath",
            "wetland",
            "beach",
            "sand",
            "bare_rock",
            "scree",
            "shingle",
            "glacier",
        ]
        .contains(&get("natural"))
        || get("waterway") == "riverbank"
}
pub fn way(w: &Way, nodes: &NodeStore) -> Value {
    let points: Option<Vec<_>> = w
        .nodes
        .iter()
        .map(|id| nodes.get(id).map(|n| n.0))
        .collect();
    let geometry = points.filter(|p| p.len() >= 2).map(|p| {
        if p.len() >= 4 && w.nodes.first() == w.nodes.last() && is_area(&w.tags) {
            json!({"type":"Polygon","coordinates":[p]})
        } else {
            json!({"type":"LineString","coordinates":p})
        }
    });
    let status = if geometry.is_some() {
        "complete"
    } else {
        "missing-nodes"
    };
    let mut v = base(
        format!("way/{}", w.id.0),
        &w.tags,
        geometry.unwrap_or(Value::Null),
        status,
    );
    v["nodeRefs"] = json!(w.nodes.iter().map(|n| n.0.to_string()).collect::<Vec<_>>());
    v["dependencyOnly"] = json!(w.tags.is_empty());
    v
}
pub fn relation(r: &Relation) -> Value {
    let mut v = base(
        format!("relation/{}", r.id.0),
        &r.tags,
        Value::Null,
        "relation-members",
    );
    v["members"] = json!(r
        .refs
        .iter()
        .map(|m| json!({"id":id(m.member),"role":m.role.as_str()}))
        .collect::<Vec<_>>());
    v
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_lines_are_not_invented_areas() {
        let mut t = Tags::new();
        t.insert("natural".into(), "coastline".into());
        assert!(!is_area(&t));
        t.insert("natural".into(), "wetland".into());
        assert!(is_area(&t));
        t.insert("area".into(), "no".into());
        assert!(!is_area(&t));
    }
}
