//! Resumable A* over independently loadable cells. Node identity is always the OSM ID.
use super::*;
use std::collections::HashMap;
mod codec;
pub use codec::{cell, extract_cell, key, partition, Cell, CELL_ZOOM};
fn snap_cells(p: [f64; 2]) -> Vec<(u32, u32)> {
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
struct Endpoint {
    snap: Snap,
    id: u32,
    a: Node,
    b: Node,
    directions: u8,
    length: f64,
    costs: [f64; 2],
}
#[derive(Clone, Copy, Debug, Hash, Eq, PartialEq, Ord, PartialOrd)]
struct Key {
    node: i64,
    way: i64,
    before: i64,
}
impl Endpoint {
    fn connections(&self) -> Vec<(Key, [f64; 2], f64, f64)> {
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
    fn snap_way(&self) -> i64 {
        self.snap.way_id[4..].parse().unwrap()
    }
    fn goals(&self) -> Vec<(i64, [f64; 2], f64, f64, i64)> {
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
#[derive(Clone, Copy)]
struct Entry {
    f: f64,
    g: f64,
    key: Key,
}
impl PartialEq for Entry {
    fn eq(&self, o: &Self) -> bool {
        self.key == o.key && self.f == o.f && self.g == o.g
    }
}
impl Eq for Entry {}
impl PartialOrd for Entry {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Entry {
    fn cmp(&self, o: &Self) -> Ordering {
        o.f.total_cmp(&self.f)
            .then_with(|| o.g.total_cmp(&self.g))
            .then_with(|| o.key.cmp(&self.key))
    }
}
struct Record {
    p: [f64; 2],
    g: f64,
    meters: f64,
    previous: Option<Key>,
}
struct Search {
    start: Endpoint,
    end: Option<Endpoint>,
    queue: BinaryHeap<Entry>,
    records: HashMap<Key, Record>,
    best: f64,
    best_meters: f64,
    finish: Option<Key>,
    direct: bool,
    visited: usize,
    pieces: HashMap<(u32, u8), crate::contours::Piece>,
}
impl Search {
    fn heuristic(&self, p: [f64; 2], speed: f64) -> f64 {
        self.end
            .as_ref()
            .map(|e| {
                e.goals()
                    .iter()
                    .map(|(_, q, t, _, _)| distance(p, *q) / speed + t)
                    .fold(f64::INFINITY, f64::min)
            })
            .unwrap_or(0.)
    }
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Step {
    NeedBlocks {
        keys: Vec<String>,
        visited: usize,
    },
    Running {
        visited: usize,
    },
    Complete {
        result: Route,
    },
    Reachable {
        result: crate::contours::Reachability,
    },
    BudgetExceeded {
        visited: usize,
    },
}
pub struct PagedRouter {
    cells: HashMap<(u32, u32), (Cell, u64)>,
    empty: HashSet<(u32, u32)>,
    tick: u64,
    touched: HashSet<(u32, u32)>,
    budget: usize,
    search_limit: usize,
    budget_exceeded: bool,
    input: Option<([f64; 2], [f64; 2])>,
    search: Option<Search>,
    profile: u32,
    bands: Vec<f64>,
}
impl PagedRouter {
    pub fn new(budget: usize, search_limit: usize) -> Self {
        Self {
            cells: HashMap::new(),
            empty: HashSet::new(),
            tick: 0,
            touched: HashSet::new(),
            budget,
            search_limit,
            budget_exceeded: false,
            input: None,
            search: None,
            profile: 0,
            bands: Vec::new(),
        }
    }
    pub fn set_profile(&mut self, profile: u32) -> Result<(), String> {
        if profile > 2 {
            return Err("Unknown transport mode".into());
        }
        if self.profile != profile {
            self.cells.clear();
            self.empty.clear();
            self.input = None;
            self.search = None;
            self.profile = profile;
        }
        Ok(())
    }
    pub fn begin(&mut self, a: [f64; 2], b: [f64; 2]) -> Result<(), String> {
        if !valid_position(a) || !valid_position(b) {
            return Err("Invalid route coordinates".into());
        }
        self.touched.clear();
        self.budget_exceeded = false;
        self.input = Some((a, b));
        self.search = None;
        self.empty.clear();
        self.bands.clear();
        Ok(())
    }
    pub fn begin_isochrone(&mut self, a: [f64; 2], bands: Vec<f64>) -> Result<(), String> {
        if bands.is_empty()
            || bands.len() > 4
            || bands
                .iter()
                .any(|v| !v.is_finite() || *v <= 0. || *v > 1800.)
            || bands.windows(2).any(|w| w[0] >= w[1])
        {
            return Err("Use 1–4 ascending time bands up to 30 minutes".into());
        }
        self.begin(a, a)?;
        self.bands = bands;
        Ok(())
    }
    fn max_speed(&self) -> f64 {
        [4.8 / 3.6, 25. / 3.6, 200. / 3.6][self.profile as usize]
    }
    pub fn used_keys(&self) -> Vec<String> {
        let mut v: Vec<_> = self.touched.iter().map(|c| key(*c)).collect();
        v.sort();
        v
    }
    pub fn memory(&self) -> usize {
        self.cells.values().map(|(c, _)| c.memory()).sum::<usize>()
            + self
                .search
                .as_ref()
                .map(|s| s.records.len() * 192 + s.queue.len() * 64 + s.pieces.len() * 96)
                .unwrap_or(0)
    }
    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }
    pub fn load(&mut self, bytes: &[u8]) -> Result<(), String> {
        let c = Cell::decode(bytes)?;
        if c.graph.profile.unwrap_or(0) != self.profile {
            return Err("Routing cell profile mismatch".into());
        }
        if c.memory() > self.budget {
            self.budget_exceeded = true;
            return Ok(());
        }
        let address = c.address;
        self.tick += 1;
        self.cells.insert(address, (c, self.tick));
        let pinned: HashSet<_> = if self.search.is_none() {
            self.input
                .map(|(a, b)| snap_cells(a).into_iter().chain(snap_cells(b)).collect())
                .unwrap_or_default()
        } else {
            HashSet::new()
        };
        while self.cells.values().map(|(c, _)| c.memory()).sum::<usize>() > self.budget {
            let old = self
                .cells
                .iter()
                .filter(|(k, _)| !pinned.contains(k))
                .min_by_key(|(_, (_, t))| *t)
                .map(|(k, _)| *k);
            if let Some(old) = old {
                self.cells.remove(&old);
            } else {
                self.cells.remove(&address);
                self.budget_exceeded = true;
                break;
            }
        }
        Ok(())
    }
    pub fn empty(&mut self, x: u32, y: u32) {
        self.empty.insert((x, y));
    }
    fn has(&self, c: &(u32, u32)) -> bool {
        self.cells.contains_key(c) || self.empty.contains(c)
    }
    fn snap(&self, p: [f64; 2]) -> Option<Endpoint> {
        let mut best: Option<Endpoint> = None;
        for address in snap_cells(p) {
            if let Some((c, _)) = self.cells.get(&address) {
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
    pub fn step(&mut self, limit: usize) -> Result<Step, String> {
        let (a, b) = self.input.ok_or("Begin a search first")?;
        if self.budget_exceeded {
            return Ok(Step::BudgetExceeded {
                visited: self.search.as_ref().map_or(0, |s| s.visited),
            });
        }
        if self.search.is_none() {
            let required: HashSet<_> = snap_cells(a).into_iter().chain(snap_cells(b)).collect();
            self.touched
                .extend(required.iter().filter(|c| self.cells.contains_key(c)));
            let mut missing: Vec<_> = required
                .iter()
                .filter(|c| !self.has(c))
                .map(|c| key(*c))
                .collect();
            missing.sort();
            if !missing.is_empty() {
                return Ok(Step::NeedBlocks {
                    keys: missing,
                    visited: 0,
                });
            }
            let Some(start) = self.snap(a) else {
                return Ok(Step::Complete {
                    result: Route::Unsnappable {
                        endpoint: "start",
                        limit_meters: SNAP_LIMIT_METERS,
                    },
                });
            };
            let end = if self.bands.is_empty() {
                let Some(e) = self.snap(b) else {
                    return Ok(Step::Complete {
                        result: Route::Unsnappable {
                            endpoint: "end",
                            limit_meters: SNAP_LIMIT_METERS,
                        },
                    });
                };
                Some(e)
            } else {
                None
            };
            let mut s = Search {
                start,
                end,
                queue: BinaryHeap::new(),
                records: HashMap::new(),
                best: self.bands.last().copied().unwrap_or(f64::INFINITY),
                best_meters: 0.,
                finish: None,
                direct: false,
                visited: 0,
                pieces: HashMap::new(),
            };
            if let Some(end) = &s.end {
                if s.start.id == end.id
                    && ((end.snap.t >= s.start.snap.t && s.start.directions & 1 != 0)
                        || (end.snap.t <= s.start.snap.t && s.start.directions & 2 != 0)
                        || (end.snap.t - s.start.snap.t).abs() < 1e-12)
                {
                    let delta = end.snap.t - s.start.snap.t;
                    s.best = delta.abs() * s.start.costs[usize::from(delta < 0.)];
                    s.best_meters = delta.abs() * s.start.length;
                    s.direct = true;
                }
            }
            for (key, p, g, meters) in s.start.connections() {
                if s.end.is_none() {
                    s.pieces.insert(
                        (s.start.id, if key.node == s.start.a.id { 2 } else { 3 }),
                        crate::contours::Piece {
                            a: s.start.snap.coordinates,
                            b: p,
                            start: 0.,
                            duration: g,
                        },
                    );
                }
                if g <= s.best {
                    s.queue.push(Entry {
                        f: g + s.heuristic(p, self.max_speed()),
                        g,
                        key,
                    });
                    s.records.insert(
                        key,
                        Record {
                            p,
                            g,
                            meters,
                            previous: None,
                        },
                    );
                }
            }
            self.search = Some(s);
        }
        let speed = self.max_speed();
        for _ in 0..limit.clamp(1, 4096) {
            let s = self.search.as_mut().unwrap();
            let Some(entry) = s.queue.pop() else {
                return self.finish();
            };
            if entry.g > s.records[&entry.key].g {
                continue;
            }
            if entry.f > s.best + 1e-7 {
                return self.finish();
            }
            let record = &s.records[&entry.key];
            let pos = record.p;
            let meters = record.meters;
            let address = cell(pos);
            if !self.cells.contains_key(&address) {
                if self.empty.contains(&address) {
                    return Err("Missing owner cell for a known routing node".into());
                }
                s.queue.push(entry);
                return Ok(Step::NeedBlocks {
                    keys: vec![key(address)],
                    visited: s.visited,
                });
            }
            self.touched.insert(address);
            self.tick += 1;
            let (c, t) = self.cells.get_mut(&address).unwrap();
            *t = self.tick;
            let i = *c
                .by_id
                .get(&entry.key.node)
                .ok_or("Routing cell is missing a referenced node")?;
            if c.graph.nodes[i].position != pos {
                return Err("Conflicting routing node coordinates".into());
            }
            s.visited += 1;
            if let Some(end) = &s.end {
                for (goal, _, tail, length, next) in end.goals() {
                    if entry.key.node == goal
                        && (tail <= 1e-12 || c.allowed(entry.key, end.snap_way(), next))
                        && entry.g + tail < s.best
                    {
                        s.best = entry.g + tail;
                        s.best_meters = meters + length;
                        s.finish = Some(entry.key);
                        s.direct = false;
                    }
                }
            }
            for arc in &c.graph.adjacency[i] {
                let n = &c.graph.nodes[arc.to];
                let seg = &c.graph.segments[arc.segment];
                if !c.allowed(entry.key, seg.way, n.id) {
                    continue;
                }
                let g = entry.g + arc.seconds;
                if s.end.is_none() && entry.g < s.best {
                    let direction = usize::from(seg.a as usize != i);
                    let id = (c.ids[arc.segment], direction as u8);
                    if s.pieces.get(&id).is_none_or(|p| entry.g < p.start) {
                        if s.pieces.len() >= self.search_limit && !s.pieces.contains_key(&id) {
                            return Ok(Step::BudgetExceeded { visited: s.visited });
                        }
                        s.pieces.insert(
                            id,
                            crate::contours::Piece {
                                a: pos,
                                b: n.position,
                                start: entry.g,
                                duration: arc.seconds,
                            },
                        );
                    }
                }
                let key = Key {
                    node: n.id,
                    way: seg.way,
                    before: entry.key.node,
                };
                if g <= s.best && s.records.get(&key).is_none_or(|v| g < v.g) {
                    if s.queue.len() >= self.search_limit * 4
                        || (!s.records.contains_key(&key) && s.records.len() >= self.search_limit)
                    {
                        return Ok(Step::BudgetExceeded { visited: s.visited });
                    }
                    s.queue.push(Entry {
                        f: g + s.heuristic(n.position, speed),
                        g,
                        key,
                    });
                    s.records.insert(
                        key,
                        Record {
                            p: n.position,
                            g,
                            meters: meters + arc.meters,
                            previous: Some(entry.key),
                        },
                    );
                }
            }
        }
        Ok(Step::Running {
            visited: self.search.as_ref().unwrap().visited,
        })
    }
    fn finish(&self) -> Result<Step, String> {
        let s = self.search.as_ref().unwrap();
        let Some(end) = &s.end else {
            return Ok(Step::Reachable {
                result: crate::contours::build(
                    s.start.snap.clone(),
                    &self.bands,
                    s.pieces.values().copied().collect(),
                    s.visited,
                ),
            });
        };
        if !s.best.is_finite() {
            return Ok(Step::Complete {
                result: Route::NoRoute {
                    start: s.start.snap.clone(),
                    end: end.snap.clone(),
                    visited: s.visited,
                },
            });
        }
        let mut coordinates = vec![s.start.snap.coordinates];
        let mut way_ids = vec![s.start.snap.way_id.clone()];
        if !s.direct {
            let mut key = s.finish.ok_or("Route reconstruction failed")?;
            let mut points = Vec::new();
            let mut ways = Vec::new();
            loop {
                let r = &s.records[&key];
                points.push(r.p);
                if let Some(prev) = r.previous {
                    ways.push(format!("way/{}", key.way));
                    key = prev;
                } else {
                    break;
                }
            }
            coordinates.extend(points.into_iter().rev());
            way_ids.extend(ways.into_iter().rev());
        }
        coordinates.push(end.snap.coordinates);
        coordinates.dedup();
        way_ids.push(end.snap.way_id.clone());
        way_ids.dedup();
        Ok(Step::Complete {
            result: Route::Found {
                coordinates,
                meters: s.best_meters,
                seconds: s.best,
                visited: s.visited,
                start: s.start.snap.clone(),
                end: end.snap.clone(),
                way_ids,
            },
        })
    }
}
impl Cell {
    fn allowed(&self, from: Key, to: i64, next: i64) -> bool {
        if from.way == 0 {
            return true;
        }
        let Some(turns) = self.turns_by_node.get(&from.node) else {
            return true;
        };
        let mut only = false;
        let mut allowed = false;
        for t in turns.iter().filter(|t| t.from == from.way) {
            let matches = t.to == to && (t.kind < 2 || next == from.before);
            if t.kind % 2 == 0 && matches {
                return false;
            }
            if t.kind % 2 == 1 {
                only = true;
                allowed |= matches;
            }
        }
        !only || allowed
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn graph(points: &[[f64; 2]], directions: u8) -> Graph {
        Graph::new(
            points
                .iter()
                .enumerate()
                .map(|(i, p)| Node {
                    id: i as i64 + 1,
                    position: *p,
                })
                .collect(),
            (0..points.len() - 1)
                .map(|i| Segment {
                    a: i as u32,
                    b: i as u32 + 1,
                    way: 100 + i as i64,
                    directions,
                })
                .collect(),
        )
        .unwrap()
    }
    fn payloads(g: &Graph) -> HashMap<String, Vec<u8>> {
        partition(g)
            .unwrap()
            .into_iter()
            .map(|(c, ids)| (key(c), extract_cell(g, c, ids).unwrap().encode()))
            .collect()
    }
    fn supply(router: &mut PagedRouter, keys: Vec<String>, data: &HashMap<String, Vec<u8>>) {
        for key in keys {
            if let Some(bytes) = data.get(&key) {
                router.load(bytes).unwrap();
            } else {
                let p: Vec<_> = key.split('/').collect();
                router.empty(p[3].parse().unwrap(), p[4].parse().unwrap());
            }
        }
    }
    fn solve(router: &mut PagedRouter, data: &HashMap<String, Vec<u8>>) -> Route {
        for _ in 0..10000 {
            match router.step(2).unwrap() {
                Step::NeedBlocks { keys, .. } => supply(router, keys, data),
                Step::Running { .. } => {}
                Step::Complete { result } => return result,
                Step::BudgetExceeded { .. } => panic!("budget"),
                Step::Reachable { .. } => panic!("unexpected isochrone"),
            }
        }
        panic!("search did not terminate")
    }
    fn same(a: Route, b: Route) {
        match (a, b) {
            (Route::Found { meters: a, .. }, Route::Found { meters: b, .. }) => {
                assert!((a - b).abs() < 1e-6, "{a} != {b}")
            }
            (Route::NoRoute { .. }, Route::NoRoute { .. }) => {}
            (Route::Unsnappable { endpoint: a, .. }, Route::Unsnappable { endpoint: b, .. }) => {
                assert_eq!(a, b)
            }
            _ => panic!("status mismatch"),
        }
    }
    #[test]
    fn resumes_across_cells_and_finds_detour_outside_endpoint_corridor() {
        let g = graph(
            &[
                [16., 48.],
                [16.02, 48.],
                [16.02, 48.04],
                [16.06, 48.04],
                [16.06, 48.],
                [16.08, 48.],
            ],
            3,
        );
        let data = payloads(&g);
        let mut router = PagedRouter::new(8192, 10000);
        let (a, b) = ([16.001, 48.], [16.079, 48.]);
        router.begin(a, b).unwrap();
        let Step::NeedBlocks { keys, .. } = router.step(2).unwrap() else {
            panic!()
        };
        let Step::NeedBlocks { keys: again, .. } = router.step(2).unwrap() else {
            panic!()
        };
        assert_eq!(keys, again);
        supply(&mut router, keys, &data);
        same(g.route(a, b).unwrap(), solve(&mut router, &data));
        assert!(router
            .used_keys()
            .iter()
            .any(|k| k == &key(cell([16.02, 48.04]))));
        router.begin(b, a).unwrap();
        same(g.route(b, a).unwrap(), solve(&mut router, &data));
    }
    #[test]
    fn snaps_long_crossing_edges_and_preserves_partial_oneway_costs() {
        let g = graph(&[[16., 48.], [16.2, 48.]], 1);
        let data = payloads(&g);
        let mut router = PagedRouter::new(8192, 1000);
        for (a, b) in [
            ([16.091, 48.], [16.099, 48.]),
            ([16.099, 48.], [16.091, 48.]),
            ([16.095, 48.], [16.095, 48.]),
            ([15., 49.], [16.1, 48.]),
        ] {
            router.begin(a, b).unwrap();
            same(g.route(a, b).unwrap(), solve(&mut router, &data));
        }
    }
    #[test]
    fn cache_eviction_does_not_lose_search_or_reconstruction() {
        let points: Vec<_> = (0..80)
            .map(|i| [16. + i as f64 * 0.005, 48. + (i % 3) as f64 * 0.001])
            .collect();
        let g = graph(&points, 3);
        let data = payloads(&g);
        let mut router = PagedRouter::new(7000, 1000);
        let a = points[0];
        let b = *points.last().unwrap();
        router.begin(a, b).unwrap();
        same(g.route(a, b).unwrap(), solve(&mut router, &data));
        assert!(router.cell_count() < router.used_keys().len());
        assert!(router.memory() < 7000 + 1000 * 160);
    }
    #[test]
    fn disconnected_crossings_and_budget_are_not_missing_data() {
        let g = Graph::new(
            vec![
                Node {
                    id: 1,
                    position: [16., 48.],
                },
                Node {
                    id: 2,
                    position: [16.04, 48.],
                },
                Node {
                    id: 3,
                    position: [16.02, 47.98],
                },
                Node {
                    id: 4,
                    position: [16.02, 48.02],
                },
            ],
            vec![
                Segment {
                    a: 0,
                    b: 1,
                    way: 1,
                    directions: 3,
                },
                Segment {
                    a: 2,
                    b: 3,
                    way: 2,
                    directions: 3,
                },
            ],
        )
        .unwrap();
        let data = payloads(&g);
        let mut router = PagedRouter::new(8192, 1000);
        router.begin([16., 48.], [16.02, 48.02]).unwrap();
        assert!(matches!(solve(&mut router, &data), Route::NoRoute { .. }));
        let points: Vec<_> = (0..20).map(|i| [16. + i as f64 * 0.002, 48.]).collect();
        let g = graph(&points, 3);
        let data = payloads(&g);
        let mut router = PagedRouter::new(20000, 3);
        router.begin(points[0], points[19]).unwrap();
        loop {
            match router.step(100).unwrap() {
                Step::NeedBlocks { keys, .. } => supply(&mut router, keys, &data),
                Step::Running { .. } => {}
                Step::BudgetExceeded { .. } => break,
                _ => panic!("Budget limit must not produce no-route"),
            }
        }
    }
    #[test]
    fn oversized_snap_working_set_reports_budget_instead_of_thrashing() {
        let g = graph(&[[16., 48.], [16.2, 48.]], 3);
        let data = payloads(&g);
        let size = Cell::decode(data.values().next().unwrap())
            .unwrap()
            .memory();
        let mut router = PagedRouter::new(size, 1000);
        router.begin([16.001, 48.], [16.199, 48.]).unwrap();
        let Step::NeedBlocks { keys, .. } = router.step(10).unwrap() else {
            panic!()
        };
        supply(&mut router, keys, &data);
        assert!(matches!(
            router.step(10).unwrap(),
            Step::BudgetExceeded { .. }
        ));
        assert!(router.memory() <= size);
        router.begin([16.091, 48.], [16.092, 48.]).unwrap();
        same(
            g.route([16.091, 48.], [16.092, 48.]).unwrap(),
            solve(&mut router, &data),
        );
    }
    #[test]
    fn cell_codec_rejects_corruption_and_duplicate_edge_identity() {
        let g = graph(&[[16., 48.], [16.01, 48.], [16.02, 48.]], 3);
        let c = extract_cell(&g, cell([16., 48.]), vec![0, 1]).unwrap();
        let mut bytes = c.encode();
        assert_eq!(Cell::decode(&bytes).unwrap().encode(), bytes);
        assert!(Cell::decode(&bytes[..bytes.len() - 1]).is_err());
        let n = bytes.len();
        bytes[n - 4..].copy_from_slice(&0u32.to_le_bytes());
        assert!(Cell::decode(&bytes).is_err());
    }
    fn transport_graph(turns: Vec<Turn>) -> Graph {
        let points = [[16., 48.], [16.001, 48.], [16.001, 48.001], [16.002, 48.]];
        Graph::new(
            points
                .iter()
                .enumerate()
                .map(|(i, p)| Node {
                    id: i as i64 + 1,
                    position: *p,
                })
                .collect(),
            [(0, 1, 10), (1, 3, 11), (0, 2, 20), (2, 3, 21)]
                .iter()
                .map(|(a, b, w)| Segment {
                    a: *a,
                    b: *b,
                    way: *w,
                    directions: 1,
                })
                .collect(),
        )
        .unwrap()
        .with_costs(
            2,
            vec![[10., 20.], [10., 20.], [30., 60.], [30., 60.]],
            turns,
        )
        .unwrap()
    }
    #[test]
    fn turn_rules_change_fastest_route_and_roundtrip_costs() {
        for (turns, expected) in [
            (vec![], 20.),
            (
                vec![Turn {
                    via: 2,
                    from: 10,
                    to: 11,
                    kind: 0,
                }],
                60.,
            ),
        ] {
            let g = transport_graph(turns);
            let bytes = g.encode();
            let decoded = Graph::decode(&bytes).unwrap();
            assert_eq!(decoded.encode(), bytes);
            let data = payloads(&decoded);
            let mut r = PagedRouter::new(1_000_000, 10000);
            r.set_profile(2).unwrap();
            r.begin([16., 48.], [16.002, 48.]).unwrap();
            let Route::Found { seconds, .. } = solve(&mut r, &data) else {
                panic!("route")
            };
            assert_eq!(seconds, expected);
            r.begin([16.002, 48.], [16., 48.]).unwrap();
            assert!(matches!(solve(&mut r, &data), Route::NoRoute { .. }));
        }
    }
    #[test]
    fn partial_edge_times_and_profile_mismatch() {
        let g = transport_graph(vec![]);
        let data = payloads(&g);
        let mut r = PagedRouter::new(1_000_000, 10000);
        assert!(r.load(data.values().next().unwrap()).is_err());
        r.set_profile(2).unwrap();
        r.begin([16.00025, 48.], [16.00075, 48.]).unwrap();
        let Route::Found { seconds, .. } = solve(&mut r, &data) else {
            panic!()
        };
        assert!((seconds - 5.).abs() < 0.01);
    }
    #[test]
    fn isochrone_resumes_missing_cells_and_clips_time_bands() {
        let g = transport_graph(vec![]);
        let data = payloads(&g);
        let mut r = PagedRouter::new(1_000_000, 10000);
        r.set_profile(2).unwrap();
        r.begin_isochrone([16., 48.], vec![5., 15., 40.]).unwrap();
        let Step::NeedBlocks { keys, .. } = r.step(1).unwrap() else {
            panic!()
        };
        let Step::NeedBlocks { keys: again, .. } = r.step(1).unwrap() else {
            panic!()
        };
        assert_eq!(keys, again);
        supply(&mut r, keys, &data);
        loop {
            match r.step(1).unwrap() {
                Step::NeedBlocks { keys, .. } => supply(&mut r, keys, &data),
                Step::Running { .. } => {}
                Step::Reachable { result } => {
                    assert_eq!(result.contours.features.len(), 3);
                    assert!(result.segments > 0);
                    let areas: Vec<_> = result
                        .contours
                        .features
                        .iter()
                        .map(|f| f.properties.area_km2)
                        .collect();
                    assert!(areas.windows(2).all(|p| p[0] <= p[1]));
                    break;
                }
                _ => panic!(),
            }
        }
        assert!(r.begin_isochrone([16., 48.], vec![60., 30.]).is_err());
        assert!(r.begin_isochrone([16., 48.], vec![1801.]).is_err());
    }
    #[test]
    fn only_turns_are_a_union_and_u_turn_is_direction_specific() {
        let mut g = transport_graph(vec![
            Turn {
                via: 2,
                from: 10,
                to: 11,
                kind: 1,
            },
            Turn {
                via: 2,
                from: 10,
                to: 20,
                kind: 1,
            },
        ]);
        let c = extract_cell(&g, cell([16., 48.]), vec![0, 1, 2, 3]).unwrap();
        let k = Key {
            node: 2,
            way: 10,
            before: 1,
        };
        assert!(c.allowed(k, 11, 4));
        assert!(c.allowed(k, 20, 3));
        assert!(!c.allowed(k, 21, 3));
        g.turns = vec![Turn {
            via: 2,
            from: 10,
            to: 10,
            kind: 2,
        }];
        let c = extract_cell(&g, cell([16., 48.]), vec![0, 1, 2, 3]).unwrap();
        assert!(!c.allowed(k, 10, 1));
        assert!(c.allowed(k, 10, 4));
    }
    #[test]
    fn fastest_route_can_be_longer_than_shortest_distance() {
        let mut g = transport_graph(vec![]);
        g = g
            .with_costs(
                2,
                vec![[200., 200.], [200., 200.], [30., 30.], [30., 30.]],
                vec![],
            )
            .unwrap();
        let mut r = PagedRouter::new(1_000_000, 10000);
        r.set_profile(2).unwrap();
        r.begin([16., 48.], [16.002, 48.]).unwrap();
        let Route::Found {
            seconds, meters, ..
        } = solve(&mut r, &payloads(&g))
        else {
            panic!()
        };
        assert_eq!(seconds, 60.);
        assert!(meters > distance([16., 48.], [16.002, 48.]) * 1.3);
    }
}
