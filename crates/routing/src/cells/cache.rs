//! Bounded decoded cell residency. Search records and pinned snap coverage are
//! owned by the caller, so eviction never erases a route continuation.
use super::*;
pub(super) struct CellCache {
    entries: HashMap<(u32, u32), (Cell, u64)>,
    empty: HashSet<(u32, u32)>,
    tick: u64,
    bytes: usize,
    budget: usize,
}
impl CellCache {
    pub(super) fn new(budget: usize) -> Self {
        Self {
            entries: HashMap::new(),
            empty: HashSet::new(),
            tick: 0,
            bytes: 0,
            budget,
        }
    }
    pub(super) fn clear(&mut self) {
        self.entries.clear();
        self.empty.clear();
        self.bytes = 0;
    }
    pub(super) fn clear_empty(&mut self) {
        self.empty.clear();
    }
    pub(super) fn mark_empty(&mut self, address: (u32, u32)) {
        self.empty.insert(address);
    }
    pub(super) fn is_empty(&self, address: &(u32, u32)) -> bool {
        self.empty.contains(address)
    }
    pub(super) fn contains(&self, address: &(u32, u32)) -> bool {
        self.entries.contains_key(address)
    }
    pub(super) fn has(&self, address: &(u32, u32)) -> bool {
        self.contains(address) || self.is_empty(address)
    }
    pub(super) fn memory(&self) -> usize {
        self.bytes
    }
    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }
    pub(super) fn get(&self, address: &(u32, u32)) -> Option<&Cell> {
        self.entries.get(address).map(|(c, _)| c)
    }
    pub(super) fn get_mut(&mut self, address: &(u32, u32)) -> Option<&mut Cell> {
        self.tick += 1;
        let (c, t) = self.entries.get_mut(address)?;
        *t = self.tick;
        Some(c)
    }
    fn remove(&mut self, address: &(u32, u32)) {
        if let Some((c, _)) = self.entries.remove(address) {
            self.bytes -= c.memory();
        }
    }
    /// False is a budget limit, never a fabricated missing cell or disconnected route.
    pub(super) fn load(
        &mut self,
        bytes: &[u8],
        profile: u32,
        pinned: &HashSet<(u32, u32)>,
    ) -> Result<bool, String> {
        let c = Cell::decode(bytes)?;
        if c.graph.profile.unwrap_or(0) != profile {
            return Err("Routing cell profile mismatch".into());
        }
        if c.memory() > self.budget {
            return Ok(false);
        }
        let address = c.address;
        self.remove(&address);
        self.empty.remove(&address);
        self.tick += 1;
        self.bytes += c.memory();
        self.entries.insert(address, (c, self.tick));
        while self.bytes > self.budget {
            let old = self
                .entries
                .iter()
                .filter(|(k, _)| !pinned.contains(k))
                .min_by_key(|(_, (_, t))| *t)
                .map(|(k, _)| *k);
            if let Some(old) = old {
                self.remove(&old);
            } else {
                self.remove(&address);
                return Ok(false);
            }
        }
        Ok(true)
    }
}
