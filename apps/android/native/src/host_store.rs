//! Read-only adapter for the running Atlas host's existing publication indexes.
//! No map copy, re-index, network proxy or access to the host's private identities.
use crate::{MAX_BLOB, policy::hash, verify};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::{
    fs::{self, File, Metadata},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

fn json(path: &Path) -> Result<Value> {
    ensure!(
        fs::metadata(path)?.len() <= 4 * 1024 * 1024,
        "Oversized host record"
    );
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn fingerprint(m: &Metadata) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128,
        m.ctime() as i128 * 1_000_000_000 + m.ctime_nsec() as i128
    )
}
struct Map {
    id: String,
    root: String,
    snapshot: String,
    offer: Value,
    db: Connection,
    path: PathBuf,
    file: File,
    fingerprint: String,
}
pub struct HostStore {
    directory: PathBuf,
    maps: Vec<Map>,
}
impl HostStore {
    pub fn open(directory: &Path) -> Result<Self> {
        let directory = directory.canonicalize()?;
        let mut maps = Vec::new();
        for entry in fs::read_dir(directory.join("hashtree"))? {
            let path = entry?.path();
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if path.extension().and_then(|s| s.to_str()) != Some("json")
                || id.len() != 36
                || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
            {
                continue;
            }
            let load = || -> Result<Map> {
                let publication = json(&path)?;
                ensure!(
                    publication["state"] == "ready" && publication["event"].is_object(),
                    "Not published"
                );
                let mut offer = publication["offer"].clone();
                let root = offer["hashtree"]["root"]
                    .as_str()
                    .context("Missing root")?
                    .to_owned();
                hash(&root)?;
                let snapshot = offer["manifest"]["snapshot"]
                    .as_str()
                    .context("Missing snapshot")?
                    .to_owned();
                ensure!(
                    offer["manifest"].get("composition").is_none(),
                    "Compound archives need a composition reader"
                );
                let db = Connection::open_with_flags(
                    path.with_extension("sqlite"),
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )?;
                db.execute_batch("PRAGMA query_only=ON; PRAGMA cache_size=-2048;")?;
                let meta: String =
                    db.query_row("SELECT json FROM meta LIMIT 1", [], |r| r.get(0))?;
                let info: Value = serde_json::from_str(&meta)?;
                ensure!(
                    info["version"] == 1
                        && info["root"] == root
                        && info["bytes"] == offer["bytes"]
                        && info["chunkBytes"] == offer["hashtree"]["chunkBytes"],
                    "Publication/index mismatch"
                );
                let path = PathBuf::from(info["path"].as_str().context("Missing indexed path")?);
                ensure!(
                    path.canonicalize()?
                        == directory
                            .join("hosted")
                            .join(format!("{id}.atlas"))
                            .canonicalize()?,
                    "Index points outside this hosted map"
                );
                let file = File::open(&path)?;
                let fp = info["fingerprint"]
                    .as_str()
                    .context("Missing fingerprint")?
                    .to_owned();
                ensure!(fingerprint(&file.metadata()?) == fp, "Indexed map changed");
                // A separate pinned native identity signs the same immutable root. No HTTP/WS hint.
                let object = offer.as_object_mut().context("Invalid offer")?;
                object.remove("api");
                object.insert("url".into(), format!("htree://{root}").into());
                let tree = offer["hashtree"].as_object_mut().context("Invalid tree")?;
                tree.remove("fips");
                tree.insert("providers".into(), serde_json::json!([]));
                Ok(Map {
                    id: id.into(),
                    root,
                    snapshot,
                    offer,
                    db,
                    path,
                    file,
                    fingerprint: fp,
                })
            };
            match load() {
                Ok(map) => maps.push(map),
                Err(e) => eprintln!("Skipping hosted map {id}: {e}"),
            }
        }
        // Geometry maps first; stable name/ID order makes the automatic default deterministic.
        maps.sort_by_key(|m| {
            (
                m.offer["manifest"]["rasters"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty()),
                m.offer["manifest"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
                m.id.clone(),
            )
        });
        let store = Self { directory, maps };
        ensure!(
            !store.offers().is_empty(),
            "No currently served, published maps have usable indexes"
        );
        Ok(store)
    }
    fn live(directory: &Path, m: &Map) -> bool {
        (|| -> Result<bool> {
            let settings = json(&directory.join("fips/settings.json"))?;
            let job = json(&directory.join("hosted").join(format!("{}.json", m.id)))?;
            let publication = json(&directory.join("hashtree").join(format!("{}.json", m.id)))?;
            Ok(settings["enabled"] == true
                && job["state"] == "ready"
                && job["served"] != false
                && job["manifest"]["snapshot"] == m.snapshot
                && publication["state"] == "ready"
                && publication["event"].is_object()
                && publication["offer"]["hashtree"]["root"] == m.root
                && publication["offer"]["manifest"]["snapshot"] == m.snapshot)
        })()
        .unwrap_or(false)
    }
    pub fn offers(&self) -> Vec<Value> {
        self.maps
            .iter()
            .filter(|m| Self::live(&self.directory, m))
            .map(|m| m.offer.clone())
            .collect()
    }
    pub fn get(&mut self, digest: &str) -> Result<Option<Vec<u8>>> {
        let expected = hash(digest)?;
        for m in &mut self.maps {
            if !Self::live(&self.directory, m) {
                continue;
            }
            ensure!(
                fingerprint(&fs::metadata(&m.path)?) == m.fingerprint
                    && fingerprint(&m.file.metadata()?) == m.fingerprint,
                "Hosted map changed; republish before reading"
            );
            let row: Option<(Option<u64>, u64, Option<Vec<u8>>)> =
                m.db.prepare_cached("SELECT start,length,data FROM blobs WHERE hash=?")?
                    .query_row([digest], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .optional()?;
            let Some((start, length, data)) = row else {
                continue;
            };
            ensure!(
                length > 0 && length <= MAX_BLOB as u64,
                "Indexed blob exceeds native bound"
            );
            let data = if let Some(data) = data {
                data
            } else {
                let start = start.context("Missing leaf offset")?;
                ensure!(
                    start
                        .checked_add(length)
                        .is_some_and(|n| n <= m.file.metadata().map(|v| v.len()).unwrap_or(0)),
                    "Indexed range exceeds file"
                );
                let mut data = vec![0; length as usize];
                m.file.seek(SeekFrom::Start(start))?;
                m.file.read_exact(&mut data)?;
                data
            };
            ensure!(
                data.len() == length as usize,
                "Indexed blob length mismatch"
            );
            verify(&data, &expected)?;
            ensure!(
                Self::live(&self.directory, m),
                "Hosted map was withdrawn during read"
            );
            ensure!(
                fingerprint(&fs::metadata(&m.path)?) == m.fingerprint,
                "Hosted map changed during read"
            );
            return Ok(Some(data));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    const ID: &str = "12345678-1234-1234-1234-123456789abc";
    struct Fixture {
        dir: PathBuf,
        root: String,
        bytes: Vec<u8>,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "atlas-host-store-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            for p in ["hashtree", "hosted", "fips"] {
                fs::create_dir_all(dir.join(p)).unwrap();
            }
            let bytes = b"ATLAS001 readonly host fixture".to_vec();
            let root = hex::encode(Sha256::digest(&bytes));
            let path = dir.join(format!("hosted/{ID}.atlas"));
            fs::write(&path, &bytes).unwrap();
            let manifest = json!({"snapshot":"snapshot-1","name":"Test","tileLayers":["water"]});
            let offer = json!({"id":ID,"bytes":bytes.len(),"manifest":manifest,"url":"http://do-not-use","api":"http://do-not-use","hashtree":{"root":root,"chunkBytes":65536,"providers":["http://do-not-use"],"fips":{"peer":"do-not-use"}}});
            fs::write(
                dir.join(format!("hashtree/{ID}.json")),
                json!({"state":"ready","event":{},"offer":offer}).to_string(),
            )
            .unwrap();
            fs::write(
                dir.join(format!("hosted/{ID}.json")),
                json!({"state":"ready","served":true,"manifest":manifest}).to_string(),
            )
            .unwrap();
            fs::write(
                dir.join("fips/settings.json"),
                json!({"enabled":true}).to_string(),
            )
            .unwrap();
            let db = Connection::open(dir.join(format!("hashtree/{ID}.sqlite"))).unwrap();
            db.execute_batch("CREATE TABLE blobs(hash TEXT PRIMARY KEY,start INTEGER,length INTEGER,data BLOB); CREATE TABLE meta(json TEXT);").unwrap();
            db.execute(
                "INSERT INTO blobs VALUES (?,0,?,NULL)",
                rusqlite::params![root, bytes.len()],
            )
            .unwrap();
            let meta = json!({"version":1,"root":root,"bytes":bytes.len(),"chunkBytes":65536,"path":path,"fingerprint":fingerprint(&fs::metadata(&path).unwrap())});
            db.execute("INSERT INTO meta VALUES (?)", [meta.to_string()])
                .unwrap();
            Self { dir, root, bytes }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    #[test]
    fn reads_existing_leaf_and_internal_node_without_copying_archive() {
        let f = Fixture::new();
        let node = b"index-inline-node";
        let digest = hex::encode(Sha256::digest(node));
        let db = Connection::open(f.dir.join(format!("hashtree/{ID}.sqlite"))).unwrap();
        db.execute(
            "INSERT INTO blobs VALUES (?,NULL,?,?)",
            rusqlite::params![digest, node.len(), node],
        )
        .unwrap();
        let mut store = HostStore::open(&f.dir).unwrap();
        assert_eq!(store.get(&f.root).unwrap().unwrap(), f.bytes);
        assert_eq!(store.get(&digest).unwrap().unwrap(), node);
        assert!(store.get(&"00".repeat(32)).unwrap().is_none());
        let offer = &store.offers()[0];
        assert!(offer.get("api").is_none());
        assert_eq!(offer["hashtree"]["providers"], json!([]));
        assert!(offer["hashtree"].get("fips").is_none());
    }
    #[test]
    fn withdrawals_and_master_switch_take_effect_without_provider_restart() {
        for mode in ["unserve", "unpublish", "fips-off"] {
            let f = Fixture::new();
            let mut store = HostStore::open(&f.dir).unwrap();
            match mode {
                "unserve" => {
                    let p = f.dir.join(format!("hosted/{ID}.json"));
                    let mut job = json(&p).unwrap();
                    job["served"] = false.into();
                    fs::write(p, job.to_string()).unwrap();
                }
                "unpublish" => fs::remove_file(f.dir.join(format!("hashtree/{ID}.json"))).unwrap(),
                _ => fs::write(f.dir.join("fips/settings.json"), r#"{"enabled":false}"#).unwrap(),
            }
            assert!(store.offers().is_empty());
            assert!(store.get(&f.root).unwrap().is_none());
        }
    }
    #[test]
    fn changed_archive_and_mismatched_index_fail_closed() {
        let f = Fixture::new();
        let mut store = HostStore::open(&f.dir).unwrap();
        fs::write(f.dir.join(format!("hosted/{ID}.atlas")), b"changed").unwrap();
        assert!(store.get(&f.root).is_err());
        assert!(HostStore::open(&f.dir).is_err());
        let f = Fixture::new();
        let db = Connection::open(f.dir.join(format!("hashtree/{ID}.sqlite"))).unwrap();
        db.execute(
            "UPDATE meta SET json=?",
            [json!({"version":1,"root":"wrong"}).to_string()],
        )
        .unwrap();
        assert!(HostStore::open(&f.dir).is_err());
    }
    #[test]
    fn corrupted_inline_blob_is_not_served() {
        let f = Fixture::new();
        let db = Connection::open(f.dir.join(format!("hashtree/{ID}.sqlite"))).unwrap();
        db.execute("UPDATE blobs SET data=?", [vec![0u8; f.bytes.len()]])
            .unwrap();
        let mut store = HostStore::open(&f.dir).unwrap();
        assert!(store.get(&f.root).is_err());
    }
}
