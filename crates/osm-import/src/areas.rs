use osmpbfreader::{NodeId, OsmId, Relation, Tags, WayId};
use std::collections::{HashMap, HashSet};
type Ring = Vec<[f64; 2]>;
/// Area semantics are shared by closed ways and multipolygon relations.
pub fn class(tags: &Tags) -> Option<u8> {
    let tag = |key: &str| tags.get(key).map(|v| v.as_str()).unwrap_or("");
    if ["building", "building:part"]
        .iter()
        .any(|key| !tag(key).is_empty() && tag(key) != "no")
    {
        Some(2)
    } else if tag("natural") == "water"
        || tag("landuse") == "reservoir"
        || tag("waterway") == "riverbank"
    {
        Some(1)
    } else if ["wood", "scrub", "grassland", "heath"].contains(&tag("natural"))
        || [
            "forest",
            "meadow",
            "grass",
            "farmland",
            "orchard",
            "vineyard",
            "recreation_ground",
        ]
        .contains(&tag("landuse"))
        || ["park", "garden", "golf_course"].contains(&tag("leisure"))
    {
        Some(0)
    } else {
        None
    }
}
fn stitch(parts: Vec<Vec<NodeId>>) -> Result<Vec<Vec<NodeId>>, &'static str> {
    let mut used = vec![false; parts.len()];
    let mut result = Vec::new();
    for i in 0..parts.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let mut ring = parts[i].clone();
        if ring.len() < 2 {
            return Err("Short member");
        }
        while ring.first() != ring.last() {
            let end = *ring.last().unwrap();
            let candidates: Vec<_> = parts
                .iter()
                .enumerate()
                .filter(|(j, p)| !used[*j] && (p.first() == Some(&end) || p.last() == Some(&end)))
                .collect();
            if candidates.len() != 1 {
                return Err("Open or ambiguous ring");
            }
            let (j, part) = candidates[0];
            used[j] = true;
            if part.first() == Some(&end) {
                ring.extend(part.iter().skip(1));
            } else {
                ring.extend(part.iter().rev().skip(1));
            }
        }
        if ring.len() < 4 || ring[..ring.len() - 1].iter().collect::<HashSet<_>>().len() < 3 {
            return Err("Degenerate ring");
        }
        result.push(ring);
    }
    Ok(result)
}
fn area(ring: &Ring) -> f64 {
    let origin = ring[0];
    ring.windows(2)
        .map(|p| {
            (p[0][0] - origin[0]) * (p[1][1] - origin[1])
                - (p[1][0] - origin[0]) * (p[0][1] - origin[1])
        })
        .sum::<f64>()
        / 2.
}
fn contains(ring: &Ring, p: [f64; 2]) -> bool {
    let mut yes = false;
    for edge in ring.windows(2) {
        let (a, b) = (edge[0], edge[1]);
        if (a[1] > p[1]) != (b[1] > p[1])
            && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            yes = !yes;
        }
    }
    yes
}
pub fn assemble(
    relation: &Relation,
    ways: &HashMap<WayId, Vec<NodeId>>,
    nodes: &HashMap<NodeId, [f64; 2]>,
) -> Result<Vec<Vec<Ring>>, &'static str> {
    let mut outer = Vec::new();
    let mut inner = Vec::new();
    let mut seen = HashSet::new();
    for member in &relation.refs {
        if !["outer", "inner", ""].contains(&member.role.as_str()) {
            continue;
        }
        let OsmId::Way(id) = member.member else {
            return Err("Nested area member unsupported");
        };
        if !seen.insert(id) {
            return Err("Duplicate member");
        }
        let way = ways.get(&id).ok_or("Missing member way")?.clone();
        if member.role == "inner" {
            inner.push(way);
        } else {
            outer.push(way);
        }
    }
    fn coordinates(
        parts: Vec<Vec<NodeId>>,
        nodes: &HashMap<NodeId, [f64; 2]>,
        positive: bool,
    ) -> Result<Vec<Ring>, &'static str> {
        stitch(parts)?
            .into_iter()
            .map(|ids| {
                let mut ring: Ring = ids
                    .iter()
                    .map(|id| nodes.get(id).copied().ok_or("Missing member node"))
                    .collect::<Result<_, _>>()?;
                let a = area(&ring);
                if a.abs() < 1e-16 {
                    return Err("Zero area");
                }
                if (a > 0.) != positive {
                    ring.reverse();
                }
                Ok(ring)
            })
            .collect()
    }
    let mut polygons: Vec<Vec<Ring>> = coordinates(outer, nodes, true)?
        .into_iter()
        .map(|ring| vec![ring])
        .collect();
    if polygons.is_empty() {
        return Err("Missing outer");
    }
    for hole in coordinates(inner, nodes, false)? {
        let candidate = polygons
            .iter()
            .enumerate()
            .filter(|(_, p)| contains(&p[0], hole[0]))
            .min_by(|(_, a), (_, b)| area(&a[0]).abs().total_cmp(&area(&b[0]).abs()))
            .map(|(i, _)| i)
            .ok_or("Hole outside outer")?;
        polygons[candidate].push(hole);
    }
    Ok(polygons)
}
#[cfg(test)]
mod tests {
    use super::*;
    use osmpbfreader::{Ref, RelationId};
    #[test]
    fn joins_reversed_ways_and_keeps_courtyard_and_separate_outer() {
        let nodes = HashMap::from([
            (NodeId(1), [0., 0.]),
            (NodeId(2), [4., 0.]),
            (NodeId(3), [4., 4.]),
            (NodeId(4), [0., 4.]),
            (NodeId(5), [1., 1.]),
            (NodeId(6), [2., 1.]),
            (NodeId(7), [2., 2.]),
            (NodeId(8), [1., 2.]),
            (NodeId(9), [6., 0.]),
            (NodeId(10), [7., 0.]),
            (NodeId(11), [7., 1.]),
            (NodeId(12), [6., 1.]),
        ]);
        let way = |ids: &[i64]| ids.iter().copied().map(NodeId).collect();
        let mut ways = HashMap::from([
            (WayId(1), way(&[1, 2, 3])),
            (WayId(2), way(&[1, 4, 3])),
            (WayId(3), way(&[5, 6, 7, 8, 5])),
            (WayId(4), way(&[9, 10, 11, 12, 9])),
        ]);
        let relation = Relation {
            id: RelationId(1),
            tags: Tags::new(),
            refs: vec![(1, "outer"), (2, "outer"), (3, "inner"), (4, "outer")]
                .into_iter()
                .map(|(id, role)| Ref {
                    member: OsmId::Way(WayId(id)),
                    role: role.into(),
                })
                .collect(),
        };
        let polygons = assemble(&relation, &ways, &nodes).unwrap();
        assert_eq!(polygons.len(), 2);
        assert_eq!(polygons[0].len(), 2);
        assert_eq!(area(&polygons[0][0]), 16.);
        assert_eq!(area(&polygons[0][1]), -1.);
        ways.remove(&WayId(2));
        assert!(assemble(&relation, &ways, &nodes).is_err());
    }
}
