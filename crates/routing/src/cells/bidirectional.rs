//! Exact two-frontier A*. Forward keys remember the incoming edge; reverse keys
//! remember the outgoing edge. A meeting is valid only when that turn is legal.
use super::*;

#[derive(Default)]
struct Frontier {
    queue: BinaryHeap<Entry>,
    records: HashMap<Key, Record>,
    at_node: HashMap<i64, Vec<Key>>,
    indexed: usize,
}
impl Frontier {
    fn top(&mut self) -> Option<Entry> {
        while let Some(e) = self.queue.peek() {
            if e.g > self.records[&e.key].g {
                self.queue.pop();
            } else {
                return Some(*e);
            }
        }
        None
    }
    fn insert(&mut self, key: Key, r: Record, potential: f64) {
        if (key.way != 0 || key.before != 0) && !self.records.contains_key(&key) {
            self.at_node.entry(key.node).or_default().push(key);
            self.indexed += 1;
        }
        self.queue.push(Entry {
            key,
            g: r.g,
            f: r.g + potential,
        });
        self.records.insert(key, r);
    }
    fn memory(&self) -> usize {
        // Includes per-node meeting index and heap/map allocation overhead.
        self.records.len() * 192 + self.indexed * 96 + self.queue.len() * 64
    }
}

pub(super) struct Bidirectional {
    start: Endpoint,
    end: Endpoint,
    fronts: [Frontier; 2],
    speed: f64,
    best: f64,
    best_meters: f64,
    meeting: Option<[Key; 2]>,
    pub(super) visited: usize,
    tie_reverse: bool,
}
impl Bidirectional {
    pub(super) fn new(start: Endpoint, end: Endpoint, speed: f64) -> Self {
        let mut s = Self {
            start,
            end,
            speed,
            fronts: Default::default(),
            best: f64::INFINITY,
            best_meters: 0.,
            meeting: None,
            visited: 0,
            tie_reverse: false,
        };
        let delta = s.end.snap.t - s.start.snap.t;
        if s.start.id == s.end.id
            && ((delta >= 0. && s.start.directions & 1 != 0)
                || (delta <= 0. && s.start.directions & 2 != 0)
                || delta.abs() < 1e-12)
        {
            s.best = delta.abs() * s.start.costs[usize::from(delta < 0.)];
            s.best_meters = delta.abs() * s.start.length;
        }
        for (key, p, g, meters) in s.start.connections() {
            let potential = s.potential(p);
            s.fronts[0].insert(
                key,
                Record {
                    p,
                    g,
                    meters,
                    previous: None,
                    way: key.way,
                },
                potential,
            );
        }
        for (node, p, g, meters, next) in s.end.goals() {
            let key = Key {
                node,
                way: if g <= 1e-12 { 0 } else { s.end.snap_way() },
                before: next,
            };
            let potential = -s.potential(p);
            s.fronts[1].insert(
                key,
                Record {
                    p,
                    g,
                    meters,
                    previous: None,
                    way: key.way,
                },
                potential,
            );
        }
        s
    }
    fn potential(&self, p: [f64; 2]) -> f64 {
        // Balanced, feasible potentials: each edge costs at least distance/speed.
        // Reverse uses -p(v), so the two frontier minima sum to a route lower
        // bound. This is exact A*, not a weighted heuristic or corridor cutoff.
        (distance(p, self.end.snap.coordinates) - distance(self.start.snap.coordinates, p))
            / (2. * self.speed)
    }
    pub(super) fn memory(&self) -> usize {
        self.fronts.iter().map(Frontier::memory).sum()
    }
    fn join(&mut self, side: usize, key: Key, c: &Cell) {
        let other_front = &self.fronts[1 - side];
        let canonical = Key {
            node: key.node,
            way: 0,
            before: 0,
        };
        let others = other_front
            .records
            .contains_key(&canonical)
            .then_some(canonical)
            .into_iter()
            .chain(
                other_front
                    .at_node
                    .get(&key.node)
                    .into_iter()
                    .flat_map(|keys| keys.iter().copied()),
            );
        for other in others {
            let keys = if side == 0 {
                [key, other]
            } else {
                [other, key]
            };
            let a = &self.fronts[0].records[&keys[0]];
            let b = &self.fronts[1].records[&keys[1]];
            if a.g + b.g < self.best
                && (keys[1].way == 0 || c.allowed(keys[0], keys[1].way, keys[1].before))
            {
                self.best = a.g + b.g;
                self.best_meters = a.meters + b.meters;
                self.meeting = Some(keys);
            }
        }
    }
    pub(super) fn step(
        &mut self,
        cells: &mut CellCache,
        touched: &mut HashSet<(u32, u32)>,
        limit: usize,
        search_limit: usize,
    ) -> Result<Step, String> {
        for _ in 0..limit.clamp(1, 4096) {
            let (Some(a), Some(b)) = (self.fronts[0].top(), self.fronts[1].top()) else {
                return self.finish();
            };
            if self.best.is_finite() && a.f + b.f >= self.best - 1e-7 {
                return self.finish();
            }
            let side = usize::from(a.f > b.f || (a.f == b.f && self.tie_reverse));
            let entry = if side == 0 { a } else { b };
            let record = &self.fronts[side].records[&entry.key];
            let (pos, meters) = (record.p, record.meters);
            let address = cell(pos);
            if !cells.contains(&address) {
                if cells.is_empty(&address) {
                    return Err("Missing owner cell for a known routing node".into());
                }
                return Ok(Step::NeedBlocks {
                    keys: vec![key(address)],
                    visited: self.visited,
                });
            }
            self.tie_reverse = !self.tie_reverse;
            self.fronts[side].queue.pop();
            touched.insert(address);
            let c = cells.get_mut(&address).unwrap();
            let i = *c
                .by_id
                .get(&entry.key.node)
                .ok_or("Routing cell is missing a referenced node")?;
            if c.graph.nodes[i].position != pos {
                return Err("Conflicting routing node coordinates".into());
            }
            self.visited += 1;
            self.join(side, entry.key, c);
            let arcs = if side == 0 {
                &c.graph.adjacency[i]
            } else {
                &c.incoming[i]
            };
            for arc in arcs {
                let n = &c.graph.nodes[arc.to];
                let seg = &c.graph.segments[arc.segment];
                let allowed = if side == 0 {
                    c.allowed(entry.key, seg.way, n.id)
                } else {
                    entry.key.way == 0
                        || c.allowed(
                            Key {
                                node: entry.key.node,
                                way: seg.way,
                                before: n.id,
                            },
                            entry.key.way,
                            entry.key.before,
                        )
                };
                if !allowed {
                    continue;
                }
                let g = entry.g + arc.seconds;
                // Arrival/departure history only changes legal moves at a node
                // carrying turn restrictions. Else all histories are equivalent.
                // Keep the traversed way on the record for route reconstruction.
                let restricted = c.turns_by_node.contains_key(&n.id);
                let key = Key {
                    node: n.id,
                    way: if restricted { seg.way } else { 0 },
                    before: if restricted { entry.key.node } else { 0 },
                };
                if g > self.best
                    || self.fronts[side]
                        .records
                        .get(&key)
                        .is_some_and(|r| r.g <= g)
                {
                    continue;
                }
                let count: usize = self.fronts.iter().map(|f| f.records.len()).sum();
                let queued: usize = self.fronts.iter().map(|f| f.queue.len()).sum();
                if queued >= search_limit * 4
                    || (count >= search_limit && !self.fronts[side].records.contains_key(&key))
                {
                    return Ok(Step::BudgetExceeded {
                        visited: self.visited,
                    });
                }
                let potential = self.potential(n.position) * if side == 0 { 1. } else { -1. };
                self.fronts[side].insert(
                    key,
                    Record {
                        p: n.position,
                        g,
                        meters: meters + arc.meters,
                        previous: Some(entry.key),
                        way: seg.way,
                    },
                    potential,
                );
                // Each cell retains all turn rules at its segment endpoints,
                // including boundary nodes. Check every improved tentative label:
                // the first meeting is only an upper bound, never a stopping rule.
                self.join(side, key, c);
            }
        }
        Ok(Step::Running {
            visited: self.visited,
        })
    }
    fn finish(&self) -> Result<Step, String> {
        if !self.best.is_finite() {
            return Ok(Step::Complete {
                result: Route::NoRoute {
                    start: self.start.snap.clone(),
                    end: self.end.snap.clone(),
                    visited: self.visited,
                },
            });
        }
        let mut coordinates = vec![self.start.snap.coordinates];
        let mut way_ids = vec![self.start.snap.way_id.clone()];
        if let Some(keys) = self.meeting {
            for (side, mut key) in keys.into_iter().enumerate() {
                let mut points = Vec::new();
                let mut ways = Vec::new();
                loop {
                    let r = &self.fronts[side].records[&key];
                    points.push(r.p);
                    if let Some(prev) = r.previous {
                        ways.push(format!("way/{}", r.way));
                        key = prev;
                    } else {
                        break;
                    }
                }
                if side == 0 {
                    points.reverse();
                    ways.reverse();
                }
                coordinates.extend(points);
                way_ids.extend(ways);
            }
        }
        coordinates.push(self.end.snap.coordinates);
        coordinates.dedup();
        way_ids.push(self.end.snap.way_id.clone());
        way_ids.dedup();
        Ok(Step::Complete {
            result: Route::Found {
                coordinates,
                way_ids,
                meters: self.best_meters,
                seconds: self.best,
                visited: self.visited,
                start: self.start.snap.clone(),
                end: self.end.snap.clone(),
            },
        })
    }
}
