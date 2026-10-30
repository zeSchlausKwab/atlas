//! Routing cell layout, validation and graph partitioning.
use crate::*;
use std::collections::{BTreeMap, HashMap};
pub const CELL_ZOOM: u32 = 14;
pub fn cell(p: [f64; 2]) -> (u32, u32) {
    let n = (1_u32 << CELL_ZOOM) as f64;
    let lat = p[1].to_radians();
    (
        ((p[0] + 180.) / 360. * n).floor().clamp(0., n - 1.) as u32,
        ((1. - (lat.tan() + 1. / lat.cos()).ln() / std::f64::consts::PI) / 2. * n)
            .floor()
            .clamp(0., n - 1.) as u32,
    )
}
pub fn key(c: (u32, u32)) -> String {
    format!("routing/cells/{}/{}/{}", CELL_ZOOM, c.0, c.1)
}
pub struct Cell {
    pub address: (u32, u32),
    pub graph: Graph,
    pub ids: Vec<u128>,
    pub stable_ids: bool,
    pub(super) incoming: Vec<Vec<Arc>>,
    pub(super) by_id: HashMap<i64, usize>,
    pub(super) turns_by_node: HashMap<i64, Vec<Turn>>,
}
impl Cell {
    pub fn new(address: (u32, u32), graph: Graph, ids: Vec<u32>) -> Result<Self, String> {
        Self::with_ids(
            address,
            graph,
            ids.into_iter().map(u128::from).collect(),
            false,
        )
    }
    /// OSM way ID plus the segment's index in the complete original way.
    /// Independent of extract extent, accepted-profile filtering and compiler order.
    pub fn osm(address: (u32, u32), graph: Graph, ids: Vec<u128>) -> Result<Self, String> {
        Self::with_ids(address, graph, ids, true)
    }
    fn with_ids(
        address: (u32, u32),
        graph: Graph,
        ids: Vec<u128>,
        stable_ids: bool,
    ) -> Result<Self, String> {
        if address.0 >= 1 << CELL_ZOOM
            || address.1 >= 1 << CELL_ZOOM
            || graph.nodes.len() > 200_000
            || graph.segments.len() > 300_000
            || graph.turns.len() > 50_000
            || ids.len() != graph.segments.len()
            || ids.windows(2).any(|v| v[0] >= v[1])
            || (stable_ids
                && (graph.profile.is_none()
                    || ids
                        .iter()
                        .zip(&graph.segments)
                        .any(|(id, segment)| segment.way <= 0 || *id >> 32 != segment.way as u128)))
        {
            return Err("Invalid routing cell".into());
        }
        let by_id = graph
            .nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id, i))
            .collect();
        let mut turns_by_node = HashMap::<i64, Vec<Turn>>::new();
        for t in &graph.turns {
            turns_by_node.entry(t.via).or_default().push(*t);
        }
        let mut incoming = vec![Vec::new(); graph.nodes.len()];
        for (from, arcs) in graph.adjacency.iter().enumerate() {
            for arc in arcs {
                incoming[arc.to].push(Arc {
                    to: from,
                    segment: arc.segment,
                    meters: arc.meters,
                    seconds: arc.seconds,
                });
            }
        }
        Ok(Self {
            incoming,
            turns_by_node,
            address,
            graph,
            ids,
            stable_ids,
            by_id,
        })
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut out = if self.stable_ids {
            b"RCL3".to_vec()
        } else if self.graph.profile.is_some() {
            b"RCL2".to_vec()
        } else {
            b"RCL1".to_vec()
        };
        for v in [CELL_ZOOM, self.address.0, self.address.1] {
            out.extend(v.to_le_bytes());
        }
        out.extend(self.graph.encode());
        for id in &self.ids {
            if self.stable_ids {
                out.extend(id.to_le_bytes());
            } else {
                out.extend((*id as u32).to_le_bytes());
            }
        }
        out
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 28
            || (&bytes[..4] != b"RCL1" && &bytes[..4] != b"RCL2" && &bytes[..4] != b"RCL3")
        {
            return Err("Invalid routing cell header".into());
        }
        let u = |i| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        if u(4) != CELL_ZOOM {
            return Err("Unsupported routing cell zoom".into());
        }
        let (n, e) = (u(20) as usize, u(24) as usize);
        if n > 200_000 || e > 300_000 {
            return Err("Invalid routing cell size".into());
        }
        let stable_ids = &bytes[..4] == b"RCL3";
        let end = if &bytes[..4] != b"RCL1" {
            if bytes.len() < 36 || &bytes[16..20] != b"RTE2" {
                return Err("Invalid profiled cell".into());
            }
            let t = u(28) as usize;
            if t > 50_000 {
                return Err("Routing cell has too many restrictions".into());
            }
            36 + n * 24 + e * 28 + t * 32
        } else {
            28 + n * 24 + e * 20
        };
        if n > 200_000 || e > 300_000 || bytes.len() != end + e * if stable_ids { 16 } else { 4 } {
            return Err("Invalid routing cell size".into());
        }
        let graph = Graph::decode(&bytes[16..end])?;
        let ids = bytes[end..]
            .chunks_exact(if stable_ids { 16 } else { 4 })
            .map(|v| {
                if stable_ids {
                    u128::from_le_bytes(v.try_into().unwrap())
                } else {
                    u32::from_le_bytes(v.try_into().unwrap()) as u128
                }
            })
            .collect();
        Self::with_ids((u(8), u(12)), graph, ids, stable_ids)
    }
    pub(super) fn memory(&self) -> usize {
        self.graph.nodes.len() * 128
            + self.graph.segments.len() * 272
            + self.graph.turns.len() * 96
            + 256
    }
}
/// Conservative segment bounding-box coverage supports snapping even when neither
/// endpoint is in the clicked cell. Geometry and direction flags are never clipped.
pub fn partition(graph: &Graph) -> Result<BTreeMap<(u32, u32), Vec<u32>>, String> {
    let mut groups = BTreeMap::<_, Vec<_>>::new();
    for (i, s) in graph.segments.iter().enumerate() {
        let a = cell(graph.nodes[s.a as usize].position);
        let b = cell(graph.nodes[s.b as usize].position);
        let (xmin, xmax, ymin, ymax) = (a.0.min(b.0), a.0.max(b.0), a.1.min(b.1), a.1.max(b.1));
        if (xmax - xmin + 1) as u64 * (ymax - ymin + 1) as u64 > 4096 {
            return Err("Routing segment spans too many cells (dateline/invalid extract)".into());
        }
        for x in xmin..=xmax {
            for y in ymin..=ymax {
                groups.entry((x, y)).or_default().push(i as u32);
            }
        }
    }
    Ok(groups)
}
pub fn extract_cell(graph: &Graph, address: (u32, u32), ids: Vec<u32>) -> Result<Cell, String> {
    let mut nodes = Vec::new();
    let mut indices = HashMap::new();
    let mut segments = Vec::new();
    for id in &ids {
        let s = &graph.segments[*id as usize];
        let mut add = |i: u32| {
            *indices.entry(i).or_insert_with(|| {
                let v = nodes.len() as u32;
                nodes.push(graph.nodes[i as usize].clone());
                v
            })
        };
        segments.push(Segment {
            a: add(s.a),
            b: add(s.b),
            way: s.way,
            directions: s.directions,
        });
    }
    let mut local = Graph::new(nodes, segments)?;
    if let Some(profile) = graph.profile {
        let node_ids: HashSet<_> = local.nodes.iter().map(|n| n.id).collect();
        local = local.with_costs(
            profile,
            ids.iter().map(|id| graph.costs[*id as usize]).collect(),
            graph
                .turns
                .iter()
                .filter(|t| node_ids.contains(&t.via))
                .copied()
                .collect(),
        )?;
    }
    Cell::new(address, local, ids)
}
