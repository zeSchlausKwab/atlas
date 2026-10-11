//! Durable blob-boundary cursors. Data is flushed before the matching SQLite commit.
use memmap2::MmapMut;
use osmpbfreader::{osmformat::PrimitiveBlock, primitive_block_from_blob, OsmPbfReader};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::{Seek, SeekFrom},
    path::Path,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
pub type Error = Box<dyn std::error::Error>;
#[derive(Default, Serialize, Deserialize)]
pub struct State {
    pub identity: String,
    pub stage: usize,
    pub offset: u64,
    pub max_node: i64,
    pub first_way: Option<u64>,
    pub node_end: u64,
    pub totals: [u64; 3],
    pub unsupported: [u64; 3],
    pub coordinates: usize,
    pub ids: [u64; 3],
    pub skipped: [u64; 3],
    pub ways: u64,
    pub counts: [[u64; 4]; 3],
}
impl State {
    pub fn open(db: &Connection, source: &str) -> Result<Self, Error> {
        let meta = std::fs::metadata(source)?;
        let identity = serde_json::to_string(&(
            2,
            std::fs::canonicalize(source)?,
            meta.len(),
            meta.modified()?.duration_since(UNIX_EPOCH)?.as_nanos(),
            std::env::var("ATLAS_GRAPH_SOURCE_HASH").unwrap_or_default(),
        ))?;
        let old: Option<String> = db
            .query_row("SELECT state FROM checkpoint WHERE id=1", [], |r| r.get(0))
            .optional()?;
        if let Some(old) = old {
            let state: Self = serde_json::from_str(&old)?;
            if state.identity != identity {
                return Err("Graph checkpoint belongs to a different source or compiler".into());
            }
            Ok(state)
        } else {
            Ok(Self {
                identity,
                ..Self::default()
            })
        }
    }
    pub fn commit(&self, db: &Connection) -> Result<(), Error> {
        db.execute(
            "INSERT OR REPLACE INTO checkpoint VALUES(1,?)",
            [serde_json::to_string(self)?],
        )?;
        db.execute_batch("COMMIT; BEGIN IMMEDIATE;")?;
        Ok(())
    }
}
pub fn next_block(file: &mut File) -> Result<Option<PrimitiveBlock>, Error> {
    let blob = OsmPbfReader::new(file).blobs().next().transpose()?;
    blob.map(|b| primitive_block_from_blob(&b).map_err(Into::into))
        .transpose()
}
pub fn seek(source: &str, offset: u64) -> Result<File, Error> {
    let mut file = File::open(source)?;
    file.seek(SeekFrom::Start(offset))?;
    Ok(file)
}
/// A bit per source ID, file-backed rather than a multi-billion-entry hash set.
/// References to absent nodes stay absent, matching the regional compiler.
pub struct Needed {
    map: MmapMut,
    file: File,
}
impl Needed {
    pub fn open(path: &Path, max_id: i64, existing: bool) -> Result<Self, Error> {
        let size = (max_id.max(0) as u64 / 8 + 1).max(1);
        if size > 4 * 1024u64.pow(3) {
            return Err("Routing node membership exceeds 4 GiB budget".into());
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(!existing)
            .truncate(false)
            .open(path)?;
        if existing && file.metadata()?.len() != size {
            return Err("Routing membership checkpoint size mismatch".into());
        }
        file.set_len(size)?;
        // SAFETY: exclusive compiler workspace; mapping is dropped before file removal.
        let map = unsafe { MmapMut::map_mut(&file)? };
        Ok(Self { map, file })
    }
    pub fn insert(&mut self, id: i64) {
        if id >= 0 {
            if let Some(byte) = self.map.get_mut(id as usize / 8) {
                *byte |= 1 << (id as usize % 8);
            }
        }
    }
    pub fn contains(&self, id: i64) -> bool {
        id >= 0
            && self
                .map
                .get(id as usize / 8)
                .is_some_and(|byte| byte & (1 << (id as usize % 8)) != 0)
    }
    pub fn flush(&self) -> Result<(), Error> {
        self.map.flush()?;
        self.file.sync_all()?;
        Ok(())
    }
}
pub struct Progress {
    start: Instant,
    saved: Instant,
    blocks: usize,
    initial: u64,
}
impl Progress {
    pub fn new(initial: u64) -> Self {
        Self {
            start: Instant::now(),
            saved: Instant::now(),
            blocks: 0,
            initial,
        }
    }
    pub fn due(&mut self) -> bool {
        self.blocks += 1;
        let limit = std::env::var("ATLAS_GRAPH_CHECKPOINT_BLOBS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(128)
            .max(1);
        self.blocks >= limit || self.saved.elapsed().as_secs() >= 5
    }
    pub fn report(
        &mut self,
        stage: &str,
        message: &str,
        completed: u64,
        total: u64,
        unit: &str,
        stage_index: usize,
    ) {
        self.saved = Instant::now();
        self.blocks = 0;
        let elapsed = self.start.elapsed().as_secs_f64();
        let rate = completed.saturating_sub(self.initial) as f64 / elapsed.max(0.001);
        let eta = if elapsed >= 5. && rate > 0. && completed < total {
            Some((total - completed) as f64 / rate)
        } else {
            None
        };
        eprintln!(
            "ATLAS_PROGRESS {}",
            serde_json::json!({"stage":stage,"message":message,"completed":completed,"total":total,"unit":unit,"stageIndex":stage_index,"stageCount":8,"elapsedSeconds":elapsed,"etaSeconds":eta,"rate":rate,"checkpointAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()})
        );
    }
}
