//! Append sorted OSM coordinates to a private disk file, then binary-search a read-only mapping.
//! Heap use is independent of node count. The OS can reclaim file-backed pages.
use memmap2::Mmap;
use osmpbfreader::NodeId;
use std::fs::File;
use std::io::{self, BufWriter, Write};
const WIDTH: usize = 32;
pub struct NodeWriter {
    file: BufWriter<File>,
    last: Option<i64>,
    count: usize,
}
pub struct NodeStore {
    map: Option<Mmap>,
    count: usize,
}
impl NodeWriter {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            file: BufWriter::new(tempfile::tempfile()?),
            last: None,
            count: 0,
        })
    }
    pub fn push(&mut self, id: NodeId, position: [f64; 2], blocked: [bool; 3]) -> io::Result<()> {
        if self.last.is_some_and(|last| id.0 <= last) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "PBF nodes must have unique, ascending IDs; run osmium sort first",
            ));
        }
        let mut record = [0u8; WIDTH];
        record[..8].copy_from_slice(&id.0.to_le_bytes());
        record[8..16].copy_from_slice(&position[0].to_le_bytes());
        record[16..24].copy_from_slice(&position[1].to_le_bytes());
        record[24] = blocked
            .iter()
            .enumerate()
            .fold(0, |bits, (i, b)| bits | (u8::from(*b) << i));
        self.file.write_all(&record)?;
        self.last = Some(id.0);
        self.count += 1;
        Ok(())
    }
    pub fn finish(mut self) -> io::Result<NodeStore> {
        self.file.flush()?;
        // SAFETY: tempfile creates a private file. No file handle escapes this builder,
        // which is consumed here; nothing can truncate or write to the mapped file.
        let map = if self.count == 0 {
            None
        } else {
            Some(unsafe { Mmap::map(self.file.get_ref())? })
        };
        eprintln!(
            "Disk coordinate index: {} nodes, {} bytes",
            self.count,
            self.count * WIDTH
        );
        Ok(NodeStore {
            map,
            count: self.count,
        })
    }
}
impl NodeStore {
    pub fn get(&self, id: &NodeId) -> Option<([f64; 2], [bool; 3])> {
        let map = self.map.as_ref()?;
        let (mut lo, mut hi) = (0, self.count);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let row = &map[mid * WIDTH..(mid + 1) * WIDTH];
            let key = i64::from_le_bytes(row[..8].try_into().unwrap());
            match key.cmp(&id.0) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => {
                    return Some((
                        [
                            f64::from_le_bytes(row[8..16].try_into().unwrap()),
                            f64::from_le_bytes(row[16..24].try_into().unwrap()),
                        ],
                        [row[24] & 1 != 0, row[24] & 2 != 0, row[24] & 4 != 0],
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
    fn sparse_ids_coordinates_and_barriers_survive_disk_index() {
        let mut w = NodeWriter::new().unwrap();
        for i in 0..10000 {
            w.push(
                NodeId(i * 100003),
                [i as f64 / 10., -48.],
                [i % 2 == 0, false, true],
            )
            .unwrap();
        }
        let s = w.finish().unwrap();
        for i in [0, 1, 200, 5001, 9999] {
            assert_eq!(
                s.get(&NodeId(i * 100003)),
                Some(([i as f64 / 10., -48.], [i % 2 == 0, false, true]))
            );
        }
        assert!(s.get(&NodeId(2)).is_none());
        assert!(s.get(&NodeId(-1)).is_none());
        assert!(s.get(&NodeId(i64::MAX)).is_none());
    }
    #[test]
    fn rejects_duplicates_and_unsorted_input() {
        let mut w = NodeWriter::new().unwrap();
        w.push(NodeId(2), [0., 0.], [false; 3]).unwrap();
        assert!(w.push(NodeId(2), [0., 0.], [false; 3]).is_err());
        assert!(w.push(NodeId(1), [0., 0.], [false; 3]).is_err());
        assert!(NodeWriter::new()
            .unwrap()
            .finish()
            .unwrap()
            .get(&NodeId(0))
            .is_none());
    }
}
