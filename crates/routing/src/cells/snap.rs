//! Endpoint selection and directional partial-edge costs.
use super::*;
pub(super) fn snap_cells(p: [f64; 2]) -> Vec<(u32, u32)> {
    let lat = (SNAP_LIMIT_METERS / 6_371_000.).to_degrees() + 1e-8;
    let lon = lat / (p[1].abs() + lat).to_radians().cos();
    let a = cell([p[0] - lon, p[1] + lat]);
    let b = cell([p[0] + lon, p[1] - lat]);
    let mut cells = Vec::new();
    for x in a.0..=b.0 {
        for y in a.1..=b.1 {
            cells.push((x, y));
        }
    }
    cells
}
#[derive(Clone)]
pub(super) struct Endpoint {
    pub(super) snap: Snap,
    pub(super) id: u32,
    pub(super) a: Node,
    pub(super) b: Node,
    pub(super) directions: u8,
    pub(super) length: f64,
    pub(super) costs: [f64; 2],
}
#[derive(Clone, Copy, Debug, Hash, Eq, PartialEq, Ord, PartialOrd)]
pub(super) struct Key {
    pub(super) node: i64,
    pub(super) way: i64,
    pub(super) before: i64,
}
impl Endpoint {
    pub(super) fn connections(&self) -> Vec<(Key, [f64; 2], f64, f64)> {
        let mut v = Vec::new();
        let t = self.snap.t;
        if t <= 1e-12 || self.directions & 2 != 0 {
            v.push((
                Key {
                    node: self.a.id,
                    way: if t <= 1e-12 { 0 } else { self.snap_way() },
                    before: self.b.id,
                },
                self.a.position,
                t * self.costs[1],
                t * self.length,
            ));
        }
        if t >= 1. - 1e-12 || self.directions & 1 != 0 {
            v.push((
                Key {
                    node: self.b.id,
                    way: if t >= 1. - 1e-12 { 0 } else { self.snap_way() },
                    before: self.a.id,
                },
                self.b.position,
                (1. - t) * self.costs[0],
                (1. - t) * self.length,
            ));
        }
        v
    }
    pub(super) fn snap_way(&self) -> i64 {
        self.snap.way_id[4..].parse().unwrap()
    }
    pub(super) fn goals(&self) -> Vec<(i64, [f64; 2], f64, f64, i64)> {
        let mut v = Vec::new();
        let t = self.snap.t;
        if t <= 1e-12 || self.directions & 1 != 0 {
            v.push((
                self.a.id,
                self.a.position,
                t * self.costs[0],
                t * self.length,
                self.b.id,
            ));
        }
        if t >= 1. - 1e-12 || self.directions & 2 != 0 {
            v.push((
                self.b.id,
                self.b.position,
                (1. - t) * self.costs[1],
                (1. - t) * self.length,
                self.a.id,
            ));
        }
        v
    }
}
pub(super) fn snap(cells: &super::cache::CellCache, p: [f64; 2]) -> Option<Endpoint> {
    let mut best: Option<Endpoint> = None;
    for address in snap_cells(p) {
        if let Some(c) = cells.get(&address) {
            if let Some(snap) = c.graph.snap(p) {
                let seg = &c.graph.segments[snap.segment];
                let id = c.ids[snap.segment];
                if best.as_ref().is_none_or(|v| {
                    snap.distance_meters < v.snap.distance_meters
                        || snap.distance_meters == v.snap.distance_meters && id < v.id
                }) {
                    best = Some(Endpoint {
                        id,
                        a: c.graph.nodes[seg.a as usize].clone(),
                        b: c.graph.nodes[seg.b as usize].clone(),
                        directions: seg.directions,
                        length: c.graph.lengths[snap.segment],
                        costs: c.graph.costs[snap.segment],
                        snap,
                    });
                }
            }
        }
    }
    best
}
