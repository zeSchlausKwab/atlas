//! A small, deterministic, distance-weighted walking graph. No display geometry is used.
pub mod cells;
pub mod contours;
use serde::Serialize;
use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashSet},
};

pub const SNAP_LIMIT_METERS: f64 = 150.0;
// Native preparation can handle larger regional graphs. Browser kernels still
// consume small cells and retain the original defensive full-graph limits.
const MAX_GRAPH_NODES: usize = if cfg!(target_arch = "wasm32") {
    8_000_000
} else {
    32_000_000
};
const MAX_GRAPH_SEGMENTS: usize = if cfg!(target_arch = "wasm32") {
    12_000_000
} else {
    48_000_000
};
#[derive(Clone, Debug)]
pub struct Node {
    pub id: i64,
    pub position: [f64; 2],
}
#[derive(Clone, Debug)]
pub struct Segment {
    pub a: u32,
    pub b: u32,
    pub way: i64,
    /// Bit 0: a -> b, bit 1: b -> a. Zero is invalid.
    pub directions: u8,
}
#[derive(Clone, Copy)]
struct Arc {
    to: usize,
    segment: usize,
    meters: f64,
    seconds: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Turn {
    pub via: i64,
    pub from: i64,
    pub to: i64,
    pub kind: u8,
}
pub struct Graph {
    pub nodes: Vec<Node>,
    pub segments: Vec<Segment>,
    adjacency: Vec<Vec<Arc>>,
    lengths: Vec<f64>,
    pub costs: Vec<[f64; 2]>,
    pub turns: Vec<Turn>,
    pub profile: Option<u32>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snap {
    pub coordinates: [f64; 2],
    pub distance_meters: f64,
    pub way_id: String,
    #[serde(skip)]
    segment: usize,
    #[serde(skip)]
    t: f64,
}
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Route {
    Found {
        coordinates: Vec<[f64; 2]>,
        meters: f64,
        seconds: f64,
        visited: usize,
        start: Snap,
        end: Snap,
        #[serde(rename = "wayIds")]
        way_ids: Vec<String>,
    },
    NoRoute {
        start: Snap,
        end: Snap,
        visited: usize,
    },
    Unsnappable {
        endpoint: &'static str,
        #[serde(rename = "limitMeters")]
        limit_meters: f64,
    },
}
#[derive(Clone, Copy)]
struct State {
    cost: f64,
    node: usize,
}
impl PartialEq for State {
    fn eq(&self, other: &Self) -> bool {
        self.node == other.node && self.cost == other.cost
    }
}
impl Eq for State {}
impl PartialOrd for State {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for State {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .cost
            .total_cmp(&self.cost)
            .then_with(|| other.node.cmp(&self.node))
    }
}
pub fn distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dlat = (b[1] - a[1]).to_radians();
    let dlon = (b[0] - a[0]).to_radians();
    let h = (dlat / 2.0).sin().powi(2)
        + a[1].to_radians().cos() * b[1].to_radians().cos() * (dlon / 2.0).sin().powi(2);
    12_742_000.0 * h.clamp(0.0, 1.0).sqrt().asin()
}
fn valid_position(p: [f64; 2]) -> bool {
    p.iter().all(|v| v.is_finite())
        && (-180.0..=180.0).contains(&p[0])
        && (-85.0..=85.0).contains(&p[1])
}
impl Graph {
    pub fn new(nodes: Vec<Node>, segments: Vec<Segment>) -> Result<Self, String> {
        if nodes.len() > MAX_GRAPH_NODES || segments.len() > MAX_GRAPH_SEGMENTS {
            return Err(format!(
                "Routing graph exceeds compilation limits: {} nodes, {} segments",
                nodes.len(),
                segments.len()
            ));
        }
        let mut ids = HashSet::new();
        if nodes
            .iter()
            .any(|n| !valid_position(n.position) || !ids.insert(n.id))
        {
            return Err("Invalid or duplicate routing node".into());
        }
        let mut adjacency = vec![Vec::new(); nodes.len()];
        let mut lengths = Vec::with_capacity(segments.len());
        for (i, s) in segments.iter().enumerate() {
            let (a, b) = (s.a as usize, s.b as usize);
            if a >= nodes.len() || b >= nodes.len() || a == b || !(1..=3).contains(&s.directions) {
                return Err("Invalid routing segment".into());
            }
            let meters = distance(nodes[a].position, nodes[b].position);
            lengths.push(meters);
            if s.directions & 1 != 0 {
                adjacency[a].push(Arc {
                    to: b,
                    segment: i,
                    meters,
                    seconds: meters / (4.8 / 3.6),
                });
            }
            if s.directions & 2 != 0 {
                adjacency[b].push(Arc {
                    to: a,
                    segment: i,
                    meters,
                    seconds: meters / (4.8 / 3.6),
                });
            }
        }
        Ok(Self {
            nodes,
            segments,
            adjacency,
            costs: lengths.iter().map(|m| [m / (4.8 / 3.6); 2]).collect(),
            lengths,
            turns: Vec::new(),
            profile: None,
        })
    }
    /// Mode IDs: walking=0, cycling=1, driving=2. Costs are seconds per full edge.
    pub fn with_costs(
        mut self,
        profile: u32,
        costs: Vec<[f64; 2]>,
        turns: Vec<Turn>,
    ) -> Result<Self, String> {
        if profile > 2 || costs.len() != self.segments.len() || turns.len() > 500_000 {
            return Err("Invalid transport profile or cost count".into());
        }
        let max_speed = [4.8 / 3.6, 25. / 3.6, 200. / 3.6][profile as usize];
        for (i, pair) in costs.iter().enumerate() {
            if pair.iter().any(|s| {
                !s.is_finite() || *s < 0. || *s > 1e7 || *s + 1e-4 < self.lengths[i] / max_speed
            }) {
                return Err("Invalid transport edge time".into());
            }
        }
        let ids: HashSet<_> = self.nodes.iter().map(|n| n.id).collect();
        if turns.iter().any(|t| !ids.contains(&t.via) || t.kind > 3) {
            return Err("Invalid turn restriction".into());
        }
        for (node, arcs) in self.adjacency.iter_mut().enumerate() {
            for arc in arcs {
                arc.seconds =
                    costs[arc.segment][usize::from(self.segments[arc.segment].a as usize != node)];
            }
        }
        self.costs = costs;
        self.turns = turns;
        self.profile = Some(profile);
        Ok(self)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + self.nodes.len() * 24 + self.segments.len() * 20);
        out.extend_from_slice(if self.profile.is_some() {
            b"RTE2"
        } else {
            b"RTE1"
        });
        out.extend_from_slice(&(self.nodes.len() as u32).to_le_bytes());
        out.extend_from_slice(&(self.segments.len() as u32).to_le_bytes());
        if let Some(profile) = self.profile {
            out.extend_from_slice(&(self.turns.len() as u32).to_le_bytes());
            out.extend_from_slice(&profile.to_le_bytes());
        }
        for n in &self.nodes {
            out.extend_from_slice(&n.id.to_le_bytes());
            for c in n.position {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
        for (i, s) in self.segments.iter().enumerate() {
            out.extend_from_slice(&s.a.to_le_bytes());
            out.extend_from_slice(&s.b.to_le_bytes());
            out.extend_from_slice(&s.way.to_le_bytes());
            out.extend_from_slice(&[s.directions, 0, 0, 0]);
            if self.profile.is_some() {
                for c in self.costs[i] {
                    let mut encoded = c as f32;
                    if (encoded as f64) < c {
                        encoded = f32::from_bits(encoded.to_bits() + 1);
                    }
                    out.extend_from_slice(&encoded.to_le_bytes());
                }
            }
        }
        for t in &self.turns {
            for id in [t.via, t.from, t.to] {
                out.extend_from_slice(&id.to_le_bytes());
            }
            out.extend_from_slice(&[t.kind, 0, 0, 0, 0, 0, 0, 0]);
        }
        out
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() >= 4 && &bytes[..4] == b"RTE2" {
            return Self::decode_profile(bytes);
        }
        if bytes.len() < 12 || &bytes[..4] != b"RTE1" {
            return Err("Invalid walking graph header".into());
        }
        let n = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let e = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        if n > MAX_GRAPH_NODES || e > MAX_GRAPH_SEGMENTS || bytes.len() != 12 + n * 24 + e * 20 {
            return Err("Invalid walking graph length".into());
        }
        let nodes = bytes[12..12 + n * 24]
            .chunks_exact(24)
            .map(|v| Node {
                id: i64::from_le_bytes(v[..8].try_into().unwrap()),
                position: [
                    f64::from_le_bytes(v[8..16].try_into().unwrap()),
                    f64::from_le_bytes(v[16..24].try_into().unwrap()),
                ],
            })
            .collect();
        let mut segments = Vec::with_capacity(e);
        for v in bytes[12 + n * 24..].chunks_exact(20) {
            if v[17..20] != [0, 0, 0] {
                return Err("Unsupported routing flags".into());
            }
            segments.push(Segment {
                a: u32::from_le_bytes(v[..4].try_into().unwrap()),
                b: u32::from_le_bytes(v[4..8].try_into().unwrap()),
                way: i64::from_le_bytes(v[8..16].try_into().unwrap()),
                directions: v[16],
            });
        }
        Self::new(nodes, segments)
    }
    fn decode_profile(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 20 {
            return Err("Invalid transport graph header".into());
        }
        let u = |p| u32::from_le_bytes(bytes[p..p + 4].try_into().unwrap()) as usize;
        let (n, e, t, profile) = (u(4), u(8), u(12), u(16));
        if n > MAX_GRAPH_NODES
            || e > MAX_GRAPH_SEGMENTS
            || t > 500_000
            || profile > 2
            || bytes.len() != 20 + n * 24 + e * 28 + t * 32
        {
            return Err("Invalid transport graph length".into());
        }
        let mut legacy = b"RTE1".to_vec();
        legacy.extend_from_slice(&bytes[4..12]);
        legacy.extend_from_slice(&bytes[20..20 + n * 24]);
        let mut costs = Vec::with_capacity(e);
        for v in bytes[20 + n * 24..20 + n * 24 + e * 28].chunks_exact(28) {
            legacy.extend_from_slice(&v[..20]);
            costs.push([
                f32::from_le_bytes(v[20..24].try_into().unwrap()) as f64,
                f32::from_le_bytes(v[24..28].try_into().unwrap()) as f64,
            ]);
        }
        let mut turns = Vec::with_capacity(t);
        for v in bytes[20 + n * 24 + e * 28..].chunks_exact(32) {
            if v[25..] != [0; 7] {
                return Err("Invalid turn flags".into());
            }
            turns.push(Turn {
                via: i64::from_le_bytes(v[..8].try_into().unwrap()),
                from: i64::from_le_bytes(v[8..16].try_into().unwrap()),
                to: i64::from_le_bytes(v[16..24].try_into().unwrap()),
                kind: v[24],
            });
        }
        Self::decode(&legacy)?.with_costs(profile as u32, costs, turns)
    }
    fn snap(&self, p: [f64; 2]) -> Option<Snap> {
        let cos = p[1].to_radians().cos();
        let mut best: Option<Snap> = None;
        for (i, s) in self.segments.iter().enumerate() {
            let a = self.nodes[s.a as usize].position;
            let b = self.nodes[s.b as usize].position;
            let dx = (b[0] - a[0]) * cos;
            let dy = b[1] - a[1];
            let length = dx * dx + dy * dy;
            let t = if length == 0.0 {
                0.0
            } else {
                (((p[0] - a[0]) * cos * dx + (p[1] - a[1]) * dy) / length).clamp(0.0, 1.0)
            };
            let coordinates = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            let meters = distance(p, coordinates);
            if meters <= SNAP_LIMIT_METERS
                && best.as_ref().is_none_or(|v| meters < v.distance_meters)
            {
                best = Some(Snap {
                    coordinates,
                    distance_meters: meters,
                    way_id: format!("way/{}", s.way),
                    segment: i,
                    t,
                });
            }
        }
        best
    }
    /// Partial endpoint edges preserve directionality. Actual OSM node endpoints can
    /// use every adjacent edge, even when their nearest segment is a one-way edge.
    fn connections(&self, snap: &Snap, from_start: bool) -> Vec<(usize, f64)> {
        let s = &self.segments[snap.segment];
        let length = self.lengths[snap.segment];
        let mut result = Vec::new();
        if snap.t <= 1e-12 || s.directions & (if from_start { 2 } else { 1 }) != 0 {
            result.push((s.a as usize, snap.t * length));
        }
        if snap.t >= 1.0 - 1e-12 || s.directions & (if from_start { 1 } else { 2 }) != 0 {
            result.push((s.b as usize, (1.0 - snap.t) * length));
        }
        result
    }
    pub fn route(&self, a: [f64; 2], b: [f64; 2]) -> Result<Route, String> {
        if self.profile.is_some() {
            return Err("Transport graphs require the time-aware paged router".into());
        }
        if !valid_position(a) || !valid_position(b) {
            return Err(
                "Route coordinates must be finite longitude/latitude within ±85° latitude".into(),
            );
        }
        let Some(start) = self.snap(a) else {
            return Ok(Route::Unsnappable {
                endpoint: "start",
                limit_meters: SNAP_LIMIT_METERS,
            });
        };
        let Some(end) = self.snap(b) else {
            return Ok(Route::Unsnappable {
                endpoint: "end",
                limit_meters: SNAP_LIMIT_METERS,
            });
        };
        let mut best = f64::INFINITY;
        let mut finish = None;
        let mut direct = false;
        if start.segment == end.segment {
            let flags = self.segments[start.segment].directions;
            if (end.t >= start.t && flags & 1 != 0)
                || (end.t <= start.t && flags & 2 != 0)
                || (end.t - start.t).abs() < 1e-12
            {
                best = (end.t - start.t).abs() * self.lengths[start.segment];
                direct = true;
            }
        }
        let goals = self.connections(&end, false);
        let mut distances = vec![f64::INFINITY; self.nodes.len()];
        let mut previous = vec![None::<(usize, usize)>; self.nodes.len()];
        let mut queue = BinaryHeap::new();
        for (node, cost) in self.connections(&start, true) {
            if cost < distances[node] {
                distances[node] = cost;
                queue.push(State { cost, node });
            }
        }
        let mut visited = 0;
        while let Some(State { cost, node }) = queue.pop() {
            if cost > distances[node] {
                continue;
            }
            if cost > best {
                break;
            }
            visited += 1;
            for &(target, tail) in &goals {
                if node == target && cost + tail < best {
                    best = cost + tail;
                    finish = Some(node);
                    direct = false;
                }
            }
            for edge in &self.adjacency[node] {
                let next = cost + edge.meters;
                if next < distances[edge.to] && next < best {
                    distances[edge.to] = next;
                    previous[edge.to] = Some((node, edge.segment));
                    queue.push(State {
                        cost: next,
                        node: edge.to,
                    });
                }
            }
        }
        if !best.is_finite() {
            return Ok(Route::NoRoute {
                start,
                end,
                visited,
            });
        }
        let mut coordinates = vec![start.coordinates];
        let mut way_ids = vec![start.way_id.clone()];
        if !direct {
            let mut node = finish.ok_or("Route reconstruction failed")?;
            let mut path = vec![node];
            let mut ways = Vec::new();
            while let Some((prev, segment)) = previous[node] {
                ways.push(format!("way/{}", self.segments[segment].way));
                node = prev;
                path.push(node);
            }
            coordinates.extend(path.into_iter().rev().map(|i| self.nodes[i].position));
            way_ids.extend(ways.into_iter().rev());
        }
        coordinates.push(end.coordinates);
        coordinates.dedup();
        way_ids.push(end.way_id.clone());
        way_ids.dedup();
        Ok(Route::Found {
            coordinates,
            meters: best,
            seconds: best / (4.8 / 3.6),
            visited,
            start,
            end,
            way_ids,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn node(id: i64, x: f64, y: f64) -> Node {
        Node {
            id,
            position: [x, y],
        }
    }
    fn edge(a: u32, b: u32, flags: u8) -> Segment {
        Segment {
            a,
            b,
            way: 10 + a as i64,
            directions: flags,
        }
    }
    fn line(flags: u8) -> Graph {
        Graph::new(
            vec![node(1, 9.0, 47.0), node(2, 9.01, 47.0)],
            vec![edge(0, 1, flags)],
        )
        .unwrap()
    }
    #[test]
    fn codec_round_trip_and_corruption() {
        let g = line(3);
        let bytes = g.encode();
        assert_eq!(Graph::decode(&bytes).unwrap().encode(), bytes);
        assert!(Graph::decode(&bytes[..bytes.len() - 1]).is_err());
        let mut bad = bytes.clone();
        bad[12 + 48 + 16] = 0;
        assert!(Graph::decode(&bad).is_err());
        let mut bad = bytes.clone();
        bad[12 + 48..12 + 48 + 4].copy_from_slice(&999u32.to_le_bytes());
        assert!(Graph::decode(&bad).is_err());
        let mut bad = bytes;
        bad[20..28].copy_from_slice(&f64::NAN.to_le_bytes());
        assert!(Graph::decode(&bad).is_err());
    }
    #[test]
    fn same_edge_snaps_use_partial_distance_and_direction() {
        let g = line(1);
        let Route::Found {
            meters,
            coordinates,
            ..
        } = g.route([9.002, 47.0], [9.008, 47.0]).unwrap()
        else {
            panic!()
        };
        assert!((meters - g.lengths[0] * 0.6).abs() < 0.001);
        assert_eq!(coordinates.len(), 2);
        assert!(matches!(
            g.route([9.008, 47.0], [9.002, 47.0]).unwrap(),
            Route::NoRoute { .. }
        ));
        assert!(matches!(
            line(2).route([9.008, 47.0], [9.002, 47.0]).unwrap(),
            Route::Found { .. }
        ));
    }
    #[test]
    fn shortest_connected_path_and_reverse() {
        let g = Graph::new(
            vec![
                node(1, 9., 47.),
                node(2, 9.01, 47.),
                node(3, 9.02, 47.),
                node(4, 9.01, 47.01),
            ],
            vec![edge(0, 3, 3), edge(3, 2, 3), edge(0, 1, 3), edge(1, 2, 3)],
        )
        .unwrap();
        let Route::Found {
            coordinates,
            meters,
            ..
        } = g.route([9., 47.], [9.02, 47.]).unwrap()
        else {
            panic!()
        };
        assert_eq!(coordinates, vec![[9., 47.], [9.01, 47.], [9.02, 47.]]);
        let Route::Found { meters: rev, .. } = g.route([9.02, 47.], [9., 47.]).unwrap() else {
            panic!()
        };
        assert!((meters - rev).abs() < 0.001);
    }
    #[test]
    fn geometric_crossings_do_not_create_junctions() {
        let g = Graph::new(
            vec![
                node(1, 9., 47.),
                node(2, 9.02, 47.),
                node(3, 9.01, 46.99),
                node(4, 9.01, 47.01),
            ],
            vec![edge(0, 1, 3), edge(2, 3, 3)],
        )
        .unwrap();
        assert!(matches!(
            g.route([9., 47.], [9.01, 47.01]).unwrap(),
            Route::NoRoute { .. }
        ));
    }
    #[test]
    fn node_endpoint_can_exit_via_another_oneway_edge() {
        let g = Graph::new(
            vec![node(1, 9., 47.), node(2, 9.01, 47.), node(3, 9.02, 47.)],
            vec![edge(0, 1, 1), edge(1, 2, 1)],
        )
        .unwrap();
        assert!(matches!(
            g.route([9.01, 47.], [9.02, 47.]).unwrap(),
            Route::Found { .. }
        ));
    }
    #[test]
    fn explicit_misses_and_invalid_coordinates() {
        assert!(matches!(
            line(3).route([8., 48.], [9., 47.]).unwrap(),
            Route::Unsnappable {
                endpoint: "start",
                ..
            }
        ));
        assert!(line(3).route([f64::NAN, 47.], [9., 47.]).is_err());
        let Route::Found { meters, .. } = line(3).route([9.005, 47.], [9.005, 47.]).unwrap() else {
            panic!()
        };
        assert_eq!(meters, 0.);
        assert!(Graph::new(vec![node(1, 9., 47.), node(1, 9., 47.)], vec![]).is_err());
    }
}
