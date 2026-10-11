//! Page-aligned coordinates with a small resident fence index. Each lookup touches one data page.
use memmap2::Mmap;
use osmpbfreader::NodeId;
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
const WIDTH: usize = 17;
const PAGE: usize = 4096;
const ROWS: usize = PAGE / WIDTH;
fn offset(row: usize) -> usize {
    row / ROWS * PAGE + row % ROWS * WIDTH
}
pub struct NodeWriter {
    file: BufWriter<File>,
    last: Option<i64>,
    count: usize,
}
#[cfg(test)]
thread_local! { static LOOKUP_PAGES: std::cell::RefCell<std::collections::BTreeSet<usize>> = Default::default(); }
pub struct NodeStore {
    map: Option<Mmap>,
    count: usize,
    fences: Vec<i64>,
}
impl NodeWriter {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            file: BufWriter::new(tempfile::tempfile()?),
            last: None,
            count: 0,
        })
    }
    /// Restore only committed records; an interrupted append is discarded.
    pub fn resume(path: &Path, count: usize) -> io::Result<Self> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        if file.metadata()?.len() < offset(count) as u64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Coordinate checkpoint is truncated",
            ));
        }
        file.set_len(offset(count) as u64)?;
        let last = if count == 0 {
            None
        } else {
            file.seek(SeekFrom::Start(offset(count - 1) as u64))?;
            let mut bytes = [0; 8];
            file.read_exact(&mut bytes)?;
            Some(i64::from_le_bytes(bytes))
        };
        file.seek(SeekFrom::End(0))?;
        Ok(Self {
            file: BufWriter::new(file),
            count,
            last,
        })
    }
    pub fn checkpoint(&mut self) -> io::Result<usize> {
        self.file.flush()?;
        self.file.get_ref().sync_all()?;
        Ok(self.count)
    }
    pub fn push(&mut self, id: NodeId, position: [i32; 2], blocked: [bool; 3]) -> io::Result<()> {
        if self.last.is_some_and(|last| id.0 <= last) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "PBF nodes must have unique, ascending IDs; run osmium sort first",
            ));
        }
        let mut record = [0u8; WIDTH];
        record[..8].copy_from_slice(&id.0.to_le_bytes());
        record[8..12].copy_from_slice(&position[0].to_le_bytes());
        record[12..16].copy_from_slice(&position[1].to_le_bytes());
        record[16] = blocked
            .iter()
            .enumerate()
            .fold(0, |bits, (i, b)| bits | (u8::from(*b) << i));
        self.file.write_all(&record)?;
        self.last = Some(id.0);
        self.count += 1;
        if self.count % ROWS == 0 {
            self.file.write_all(&[0; PAGE - ROWS * WIDTH])?;
        }
        Ok(())
    }
    pub fn finish(mut self) -> io::Result<NodeStore> {
        self.file.flush()?;
        NodeStore::from_file(self.file.get_ref(), self.count)
    }
}
impl NodeStore {
    pub fn open(path: &Path, count: usize) -> io::Result<Self> {
        Self::from_file(&File::open(path)?, count)
    }
    fn from_file(file: &File, count: usize) -> io::Result<Self> {
        if file.metadata()?.len() != offset(count) as u64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Coordinate checkpoint size mismatch",
            ));
        }
        // SAFETY: private compiler workspace; the writer is finished before mapping.
        // Callers must hold the workspace exclusively and never mutate a live mapping.
        let map = if count == 0 {
            None
        } else {
            Some(unsafe { Mmap::map(file)? })
        };
        let fences = map
            .as_ref()
            .map(|m| {
                (0..count)
                    .step_by(ROWS)
                    .map(|i| i64::from_le_bytes(m[offset(i)..offset(i) + 8].try_into().unwrap()))
                    .collect()
            })
            .unwrap_or_default();
        #[cfg(unix)]
        if let Some(m) = &map {
            m.advise(memmap2::Advice::Random)?;
        }
        Ok(Self { map, count, fences })
    }
    pub fn get(&self, id: &NodeId) -> Option<([f64; 2], [bool; 3])> {
        let map = self.map.as_ref()?;
        let page = self
            .fences
            .partition_point(|key| key <= &id.0)
            .checked_sub(1)?;
        let (mut lo, mut hi) = (page * ROWS, ((page + 1) * ROWS).min(self.count));
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            #[cfg(test)]
            LOOKUP_PAGES.with(|p| {
                p.borrow_mut().insert(offset(mid) / PAGE);
            });
            let row = &map[offset(mid)..offset(mid) + WIDTH];
            let key = i64::from_le_bytes(row[..8].try_into().unwrap());
            match key.cmp(&id.0) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => {
                    return Some((
                        [
                            i32::from_le_bytes(row[8..12].try_into().unwrap()) as f64 * 1e-7,
                            i32::from_le_bytes(row[12..16].try_into().unwrap()) as f64 * 1e-7,
                        ],
                        [row[16] & 1 != 0, row[16] & 2 != 0, row[16] & 4 != 0],
                    ))
                }
            }
        }
        None
    }
    pub fn contains_key(&self, id: &NodeId) -> bool {
        self.get(id).is_some()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_records_resume_at_page_boundaries_and_reject_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("coordinates");
        let mut w = NodeWriter::resume(&path, 0).unwrap();
        for id in 0..480 {
            w.push(NodeId(id), [id as i32, 0], [false; 3]).unwrap();
        }
        assert_eq!(w.checkpoint().unwrap(), 480);
        w.push(NodeId(480), [0, 0], [false; 3]).unwrap();
        w.checkpoint().unwrap();
        drop(w);
        let mut w = NodeWriter::resume(&path, 480).unwrap();
        w.push(NodeId(482), [1, 0], [true; 3]).unwrap();
        w.checkpoint().unwrap();
        drop(w);
        let store = NodeStore::open(&path, 481).unwrap();
        for id in [0, 239, 240, 479, 482] {
            assert!(store.get(&NodeId(id)).is_some());
        }
        assert!(store.get(&NodeId(480)).is_none());
        drop(store);
        assert!(NodeWriter::resume(&path, 482).is_err());
    }
    #[test]
    fn coordinate_lookup_touches_at_most_one_disk_page() {
        let mut w = NodeWriter::new().unwrap();
        for i in 0..250_000 {
            w.push(NodeId(i * 101), [0, 0], [false; 3]).unwrap();
        }
        let s = w.finish().unwrap();
        LOOKUP_PAGES.with(|p| p.borrow_mut().clear());
        assert!(s.get(&NodeId(12345 * 101)).is_some());
        LOOKUP_PAGES.with(|p| {
            assert!(
                p.borrow().len() <= 1,
                "lookup faulted across {} disk pages",
                p.borrow().len()
            )
        });
    }
    #[test]
    fn sparse_ids_coordinates_and_barriers_survive_disk_index() {
        let mut w = NodeWriter::new().unwrap();
        for i in 0..10000 {
            w.push(
                NodeId(i * 100003),
                [i as i32, -480000000],
                [i % 2 == 0, false, true],
            )
            .unwrap();
        }
        let s = w.finish().unwrap();
        for i in [0, 1, 200, 5001, 9999] {
            assert_eq!(
                s.get(&NodeId(i * 100003)),
                Some(([i as f64 * 1e-7, -48.], [i % 2 == 0, false, true]))
            );
        }
        assert!(s.get(&NodeId(2)).is_none());
        assert!(s.get(&NodeId(-1)).is_none());
        assert!(s.get(&NodeId(i64::MAX)).is_none());
    }
    #[test]
    fn rejects_duplicates_and_unsorted_input() {
        let mut w = NodeWriter::new().unwrap();
        w.push(NodeId(2), [0, 0], [false; 3]).unwrap();
        assert!(w.push(NodeId(2), [0, 0], [false; 3]).is_err());
        assert!(w.push(NodeId(1), [0, 0], [false; 3]).is_err());
        assert!(NodeWriter::new()
            .unwrap()
            .finish()
            .unwrap()
            .get(&NodeId(0))
            .is_none());
    }
}
