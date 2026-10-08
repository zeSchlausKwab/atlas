//! Resumable A* over independently loadable cells. Node identity is always the OSM ID.
use super::*;
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
    pub ids: Vec<u32>,
    by_id: HashMap<i64, usize>,
}
impl Cell {
    pub fn new(address: (u32, u32), graph: Graph, ids: Vec<u32>) -> Result<Self, String> {
        if address.0 >= 1 << CELL_ZOOM
            || address.1 >= 1 << CELL_ZOOM
            || graph.nodes.len() > 200_000
            || graph.segments.len() > 300_000
            || ids.len() != graph.segments.len()
            || ids.windows(2).any(|v| v[0] >= v[1])
        {
            return Err("Invalid routing cell".into());
        }
        let by_id = graph
            .nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id, i))
            .collect();
        Ok(Self {
            address,
            graph,
            ids,
            by_id,
        })
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut out = b"RCL1".to_vec();
        for v in [CELL_ZOOM, self.address.0, self.address.1] {
            out.extend(v.to_le_bytes());
        }
        out.extend(self.graph.encode());
        for id in &self.ids {
            out.extend(id.to_le_bytes());
        }
        out
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 28 || &bytes[..4] != b"RCL1" {
            return Err("Invalid routing cell header".into());
        }
        let u = |i| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        if u(4) != CELL_ZOOM {
            return Err("Unsupported routing cell zoom".into());
        }
        let (n, e) = (u(20) as usize, u(24) as usize);
        if n > 200_000 || e > 300_000 || bytes.len() != 28 + n * 24 + e * 24 {
            return Err("Invalid routing cell size".into());
        }
        let end = 28 + n * 24 + e * 20;
        let graph = Graph::decode(&bytes[16..end])?;
        let ids = bytes[end..]
            .chunks_exact(4)
            .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
            .collect();
        Self::new((u(8), u(12)), graph, ids)
    }
    fn memory(&self) -> usize {
        self.graph.nodes.len() * 128 + self.graph.segments.len() * 160 + 256
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
    Cell::new(address, Graph::new(nodes, segments)?, ids)
}
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
}
impl Endpoint {
    fn connections(&self, start: bool) -> Vec<(Node, f64)> {
        let mut result = Vec::new();
        let t = self.snap.t;
        if t <= 1e-12 || self.directions & (if start { 2 } else { 1 }) != 0 {
            result.push((self.a.clone(), t * self.length));
        }
        if t >= 1. - 1e-12 || self.directions & (if start { 1 } else { 2 }) != 0 {
            result.push((self.b.clone(), (1. - t) * self.length));
        }
        result
    }
}
#[derive(Clone, Copy)]
struct Entry {
    f: f64,
    g: f64,
    id: i64,
}
impl PartialEq for Entry {
    fn eq(&self, o: &Self) -> bool {
        self.id == o.id && self.f == o.f && self.g == o.g
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
            .then_with(|| o.id.cmp(&self.id))
    }
}
struct Record {
    p: [f64; 2],
    g: f64,
    previous: Option<(i64, i64)>,
}
struct Search {
    start: Endpoint,
    end: Endpoint,
    goals: Vec<(Node, f64)>,
    queue: BinaryHeap<Entry>,
    records: HashMap<i64, Record>,
    best: f64,
    finish: Option<i64>,
    direct: bool,
    visited: usize,
}
impl Search {
    fn heuristic(&self, p: [f64; 2]) -> f64 {
        self.goals
            .iter()
            .map(|(n, t)| distance(p, n.position) + t)
            .fold(f64::INFINITY, f64::min)
    }
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Step {
    NeedBlocks { keys: Vec<String>, visited: usize },
    Running { visited: usize },
    Complete { result: Route },
    BudgetExceeded { visited: usize },
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
        }
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
        Ok(())
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
                .map(|s| s.records.len() * 128 + s.queue.len() * 32)
                .unwrap_or(0)
    }
    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }
    pub fn load(&mut self, bytes: &[u8]) -> Result<(), String> {
        let c = Cell::decode(bytes)?;
        if c.memory() > self.budget {
            self.budget_exceeded = true;
            return Ok(());
        }
        let address = c.address;
        self.tick += 1;
        self.cells.insert(address, (c, self.tick));
        // Both snap neighborhoods must coexist until endpoint selection is complete.
        // Evicting one to load the other would otherwise cycle NeedBlocks forever.
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
                .filter(|(key, _)| !pinned.contains(key))
                .min_by_key(|(_, (_, t))| *t)
                .map(|(key, _)| *key);
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
        for c in snap_cells(p) {
            if let Some((c, _)) = self.cells.get(&c) {
                // Each cell is in original segment order; ties across cells use global IDs.
                if let Some(snap) = c.graph.snap(p) {
                    let s = &c.graph.segments[snap.segment];
                    let id = c.ids[snap.segment];
                    let length = c.graph.lengths[snap.segment];
                    if best.as_ref().is_none_or(|v| {
                        snap.distance_meters < v.snap.distance_meters
                            || snap.distance_meters == v.snap.distance_meters && id < v.id
                    }) {
                        best = Some(Endpoint {
                            snap,
                            id,
                            a: c.graph.nodes[s.a as usize].clone(),
                            b: c.graph.nodes[s.b as usize].clone(),
                            directions: s.directions,
                            length,
                        });
                    }
                }
            }
        }
        best
    }
    pub fn step(&mut self, limit: usize) -> Result<Step, String> {
        let (a, b) = self.input.ok_or("Begin a route first")?;
        if self.budget_exceeded {
            return Ok(Step::BudgetExceeded {
                visited: self.search.as_ref().map_or(0, |s| s.visited),
            });
        }
        if self.search.is_none() {
            let required: HashSet<_> = snap_cells(a).into_iter().chain(snap_cells(b)).collect();
            let mut missing: Vec<_> = required
                .iter()
                .filter(|c| !self.has(c))
                .map(|c| key(*c))
                .collect();
            missing.sort();
            self.touched
                .extend(required.iter().filter(|c| self.cells.contains_key(c)));
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
            let Some(end) = self.snap(b) else {
                return Ok(Step::Complete {
                    result: Route::Unsnappable {
                        endpoint: "end",
                        limit_meters: SNAP_LIMIT_METERS,
                    },
                });
            };
            let mut s = Search {
                goals: end.connections(false),
                start,
                end,
                queue: BinaryHeap::new(),
                records: HashMap::new(),
                best: f64::INFINITY,
                finish: None,
                direct: false,
                visited: 0,
            };
            if s.start.id == s.end.id
                && ((s.end.snap.t >= s.start.snap.t && s.start.directions & 1 != 0)
                    || (s.end.snap.t <= s.start.snap.t && s.start.directions & 2 != 0)
                    || (s.end.snap.t - s.start.snap.t).abs() < 1e-12)
            {
                s.best = (s.end.snap.t - s.start.snap.t).abs() * s.start.length;
                s.direct = true;
            }
            for (n, g) in s.start.connections(true) {
                s.queue.push(Entry {
                    f: g + s.heuristic(n.position),
                    g,
                    id: n.id,
                });
                s.records.insert(
                    n.id,
                    Record {
                        p: n.position,
                        g,
                        previous: None,
                    },
                );
            }
            self.search = Some(s);
        }
        for _ in 0..limit.clamp(1, 4096) {
            let s = self.search.as_mut().unwrap();
            let Some(entry) = s.queue.pop() else {
                return self.finish();
            };
            if entry.g > s.records[&entry.id].g {
                continue;
            }
            if entry.f > s.best + 1e-7 {
                return self.finish();
            }
            let pos = s.records[&entry.id].p;
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
                .get(&entry.id)
                .ok_or("Routing cell is missing a referenced node")?;
            if c.graph.nodes[i].position != pos {
                return Err("Conflicting routing node coordinates".into());
            }
            s.visited += 1;
            for (goal, tail) in &s.goals {
                if entry.id == goal.id && entry.g + tail < s.best {
                    s.best = entry.g + tail;
                    s.finish = Some(entry.id);
                    s.direct = false;
                }
            }
            for arc in &c.graph.adjacency[i] {
                let n = &c.graph.nodes[arc.to];
                let g = entry.g + arc.meters;
                if g < s.best && s.records.get(&n.id).is_none_or(|v| g < v.g) {
                    if s.queue.len() >= self.search_limit * 4
                        || (!s.records.contains_key(&n.id) && s.records.len() >= self.search_limit)
                    {
                        return Ok(Step::BudgetExceeded { visited: s.visited });
                    }
                    s.queue.push(Entry {
                        f: g + s.heuristic(n.position),
                        g,
                        id: n.id,
                    });
                    s.records.insert(
                        n.id,
                        Record {
                            p: n.position,
                            g,
                            previous: Some((entry.id, c.graph.segments[arc.segment].way)),
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
        if !s.best.is_finite() {
            return Ok(Step::Complete {
                result: Route::NoRoute {
                    start: s.start.snap.clone(),
                    end: s.end.snap.clone(),
                    visited: s.visited,
                },
            });
        }
        let mut coordinates = vec![s.start.snap.coordinates];
        let mut way_ids = vec![s.start.snap.way_id.clone()];
        if !s.direct {
            let mut id = s.finish.ok_or("Route reconstruction failed")?;
            let mut points = Vec::new();
            let mut ways = Vec::new();
            loop {
                let r = &s.records[&id];
                points.push(r.p);
                if let Some((prev, way)) = r.previous {
                    ways.push(format!("way/{way}"));
                    id = prev;
                } else {
                    break;
                }
            }
            coordinates.extend(points.into_iter().rev());
            way_ids.extend(ways.into_iter().rev());
        }
        coordinates.push(s.end.snap.coordinates);
        coordinates.dedup();
        way_ids.push(s.end.snap.way_id.clone());
        way_ids.dedup();
        Ok(Step::Complete {
            result: Route::Found {
                coordinates,
                meters: s.best,
                visited: s.visited,
                start: s.start.snap.clone(),
                end: s.end.snap.clone(),
                way_ids,
            },
        })
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
}
