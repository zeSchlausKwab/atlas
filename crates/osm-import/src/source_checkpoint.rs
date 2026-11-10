//! A source cursor and its database writes commit together. Coordinates are flushed first.
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
type Error = Box<dyn std::error::Error>;
#[derive(Default, Serialize, Deserialize)]
pub struct State {
    pub identity: String,
    #[serde(default)]
    pub last_object_relation: i64,
    pub stage: usize,
    pub offset: u64,
    pub coordinates: usize,
    pub first_way: Option<u64>,
    pub objects: u64,
    pub ways: u64,
    pub skipped_ways: u64,
    pub last_relation: i64,
    pub relations: u64,
    pub pruned: u64,
    pub assembled: u64,
    pub skipped: u64,
}
impl State {
    pub fn open(db: &Connection, source: &str) -> Result<Self, Error> {
        let meta = std::fs::metadata(source)?;
        let identity = serde_json::to_string(&(
            4,
            crate::objects::enabled(),
            std::fs::canonicalize(source)?,
            meta.len(),
            meta.modified()?.duration_since(UNIX_EPOCH)?.as_nanos(),
            std::env::var("ATLAS_SOURCE_HASH").unwrap_or_default(),
        ))?;
        let old: Option<String> = db
            .query_row("SELECT state FROM source_checkpoint WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(old) = old {
            let state: Self = serde_json::from_str(&old)?;
            if state.identity != identity {
                return Err("Source checkpoint belongs to another source or compiler".into());
            }
            Ok(state)
        } else {
            Ok(Self {
                identity,
                last_relation: -1,
                ..Self::default()
            })
        }
    }
    pub fn commit(&self, db: &Connection) -> Result<(), Error> {
        db.execute(
            "INSERT OR REPLACE INTO source_checkpoint VALUES(1,?)",
            [serde_json::to_string(self)?],
        )?;
        db.execute_batch("COMMIT; BEGIN IMMEDIATE;")?;
        Ok(())
    }
}
/// Only old, unreceipted outputs lack this cursor. The caller owns the workspace exclusively.
pub fn discard_legacy(output: &str) -> Result<(), Error> {
    if !Path::new(output).exists() {
        return Ok(());
    }
    let db = Connection::open(output)?;
    let checkpoint: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_checkpoint')",
        [],
        |r| r.get(0),
    )?;
    drop(db);
    if !checkpoint {
        eprintln!("Rebuilding legacy source geometry without a recovery cursor; completed archives are retained");
        std::fs::remove_file(output)?;
    }
    Ok(())
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
        let limit = std::env::var("ATLAS_SOURCE_CHECKPOINT_BLOBS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(128)
            .max(1);
        self.blocks >= limit || self.saved.elapsed().as_secs() >= 5
    }
    pub fn report(&mut self, stage: &str, message: &str, completed: u64, total: u64, unit: &str) {
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
            serde_json::json!({"stage":stage,"message":message,"completed":completed,"total":total,"unit":unit,"elapsedSeconds":elapsed,"etaSeconds":eta,"rate":rate,"checkpointAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()})
        );
    }
}
