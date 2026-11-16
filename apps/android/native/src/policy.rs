//! Native trust boundary. Page code can neither grant roots nor introduce descendants.
use crate::{MAX_BLOB, verify};
use anyhow::{Context, Result, ensure};
use secp256k1::{Message, Secp256k1, XOnlyPublicKey, schnorr::Signature};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub fn hash(value: &str) -> Result<[u8; 32]> {
    ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Expected lowercase SHA-256"
    );
    Ok(hex::decode(value)?.try_into().unwrap())
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u64,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}
impl Event {
    pub fn digest(&self) -> Result<[u8; 32]> {
        Ok(Sha256::digest(serde_json::to_vec(&json!([
            0,
            self.pubkey,
            self.created_at,
            self.kind,
            self.tags,
            self.content
        ]))?)
        .into())
    }
    fn tag(&self, name: &str) -> Result<&str> {
        let tags: Vec<_> = self
            .tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some(name))
            .collect();
        ensure!(
            tags.len() == 1 && tags[0].len() == 2,
            "Missing or ambiguous {name} tag"
        );
        Ok(&tags[0][1])
    }
    fn check(&self, publisher: &str, peer: &str, time: u64) -> Result<(Value, u64)> {
        ensure!(
            self.content.len() <= 256 * 1024 && self.kind == 30064 && self.pubkey == publisher,
            "Untrusted map publisher or kind"
        );
        let digest = self.digest()?;
        ensure!(hash(&self.id)? == digest, "Announcement ID mismatch");
        Secp256k1::verification_only()
            .verify_schnorr(
                &Signature::from_slice(&hex::decode(&self.sig)?)?,
                &Message::from_digest(digest),
                &XOnlyPublicKey::from_slice(&hash(publisher)?)?,
            )
            .context("Invalid map announcement signature")?;
        let expires: u64 = self.tag("expiration")?.parse()?;
        ensure!(
            self.created_at <= time.saturating_add(300)
                && expires > time
                && Some(expires) <= self.created_at.checked_add(7 * 86400),
            "Map announcement expired or outside validity window"
        );
        ensure!(
            self.tag("l")? == "hashtree"
                && self.tag("t")? == "atlas-map"
                && self.tag("native-peer")? == peer,
            "Map does not authorize this native provider"
        );
        let content: Value = serde_json::from_str(&self.content)?;
        ensure!(
            content["version"] == 1 && content["nativeProfile"] == "atlas-native-v1",
            "Unsupported native discovery profile"
        );
        let offer = content["map"].clone();
        let root = offer["hashtree"]["root"]
            .as_str()
            .context("Missing map root")?;
        hash(root)?;
        ensure!(
            self.tag("hash")? == root
                && self.tag("d")?
                    == format!("atlas/{}", offer["id"].as_str().context("Missing map id")?),
            "Signed root/address mismatch"
        );
        ensure!(
            offer["url"] == format!("htree://{root}"),
            "Native maps must use content-addressed references"
        );
        let f = &offer["manifest"];
        hash(f["snapshot"].as_str().context("Missing snapshot")?)?;
        ensure!(
            f["name"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() < 512),
            "Invalid map name"
        );
        let b = f["bounds"].as_array().context("Missing map bounds")?;
        ensure!(b.len() == 4, "Invalid bounds");
        let n: Vec<f64> = b
            .iter()
            .map(|v| v.as_f64().context("Invalid bound"))
            .collect::<Result<_>>()?;
        ensure!(
            n[0] >= -180.
                && n[2] <= 180.
                && n[1] >= -90.
                && n[3] <= 90.
                && n[0] < n[2]
                && n[1] < n[3],
            "Invalid geographic bounds"
        );
        ensure!(
            f["minZoom"].as_u64().is_some()
                && f["maxZoom"].as_u64().is_some()
                && f["minZoom"].as_u64() <= f["maxZoom"].as_u64()
                && f["maxZoom"].as_u64() <= Some(18),
            "Invalid zoom range"
        );
        Ok((offer, expires))
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Link {
    kind: u8,
    size: u64,
    depth: u8,
}
struct Root {
    expires: u64,
    links: HashMap<String, Link>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    t: u8,
    l: Vec<NodeLink>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeLink {
    #[serde(with = "serde_bytes")]
    h: Vec<u8>,
    s: u64,
    t: u8,
}
pub struct Policy {
    roots: HashMap<String, Root>,
    pub offers: Vec<Value>,
    grant: Option<String>,
    count: usize,
}
impl Policy {
    pub fn discover(bytes: &[u8], publisher: &str, peer: &str, time: u64) -> Result<Self> {
        ensure!(bytes.len() <= MAX_BLOB, "Catalog too large");
        let events: Vec<Event> = serde_json::from_slice(bytes)?;
        ensure!(
            !events.is_empty() && events.len() <= 16,
            "Native catalog must contain 1–16 maps"
        );
        let mut p = Self {
            roots: HashMap::new(),
            offers: vec![],
            grant: None,
            count: 0,
        };
        let mut ids = std::collections::HashSet::new();
        for e in events {
            let (offer, expires) = e.check(publisher, peer, time)?;
            ensure!(
                ids.insert(e.tag("d")?.to_owned()),
                "Ambiguous map revision in catalog"
            );
            let tree = &offer["hashtree"];
            let root = tree["root"].as_str().unwrap().to_owned();
            let size = offer["bytes"].as_u64().context("Invalid map size")?;
            let chunk = tree["chunkBytes"].as_u64().context("Invalid chunk size")?;
            ensure!(
                tree["version"] == 1
                    && tree["bytes"] == size
                    && size > 0
                    && size <= 9_007_199_254_740_991
                    && (16384..=MAX_BLOB as u64).contains(&chunk),
                "Invalid tree descriptor"
            );
            ensure!(!p.roots.contains_key(&root), "Duplicate root");
            p.roots.insert(
                root.clone(),
                Root {
                    expires,
                    links: HashMap::from([(
                        root,
                        Link {
                            kind: if size <= chunk { 0 } else { 1 },
                            size,
                            depth: 0,
                        },
                    )]),
                },
            );
            p.offers.push(offer);
            p.count += 1;
        }
        Ok(p)
    }
    // Only invoked by the native UI; never exposed through the page bridge.
    pub fn select(&mut self, root: &str, time: u64) -> Result<()> {
        ensure!(
            self.roots.get(root).is_some_and(|r| r.expires > time),
            "Map root is not in the current signed catalog"
        );
        self.grant = Some(root.to_owned());
        Ok(())
    }
    pub fn check(&self, root: &str, blob: &str, time: u64) -> Result<()> {
        hash(root)?;
        hash(blob)?;
        ensure!(
            self.grant.as_deref() == Some(root),
            "Map resource grant denied"
        );
        let r = self.roots.get(root).context("Unknown map root")?;
        ensure!(
            r.expires > time,
            "Map announcement expired; reconnect to refresh discovery"
        );
        ensure!(
            r.links.contains_key(blob),
            "Blob is not a verified descendant of the granted root"
        );
        Ok(())
    }
    pub fn accept(&mut self, root: &str, blob: &str, bytes: &[u8], time: u64) -> Result<()> {
        self.check(root, blob, time)?;
        ensure!(bytes.len() <= MAX_BLOB, "Oversized blob");
        verify(bytes, &hash(blob)?)?;
        let r = self.roots.get_mut(root).unwrap();
        let parent = r.links[blob];
        if parent.kind == 0 {
            ensure!(
                bytes.len() as u64 == parent.size,
                "Hashtree leaf length mismatch"
            );
            return Ok(());
        }
        ensure!(parent.depth < 16, "Hashtree depth exceeded");
        let mut cursor = std::io::Cursor::new(bytes);
        let node = Node::deserialize(&mut rmp_serde::Deserializer::new(&mut cursor))
            .context("Invalid Hashtree file node")?;
        ensure!(
            cursor.position() == bytes.len() as u64,
            "Trailing Hashtree node data"
        );
        ensure!(
            node.t == 1 && !node.l.is_empty() && node.l.len() <= 128,
            "Unsupported Hashtree file node"
        );
        let mut sum = 0u64;
        let mut children = HashMap::new();
        for l in node.l {
            ensure!(
                l.h.len() == 32 && l.s > 0 && l.t <= 1 && (l.t != 0 || l.s <= MAX_BLOB as u64),
                "Invalid Hashtree child"
            );
            sum = sum.checked_add(l.s).context("Tree size overflow")?;
            ensure!(sum <= parent.size, "Hashtree subtree length mismatch");
            let h = hex::encode(l.h);
            let child = Link {
                kind: l.t,
                size: l.s,
                depth: parent.depth + 1,
            };
            if let Some(old) = r.links.get(&h).or_else(|| children.get(&h)) {
                ensure!(
                    old.kind == child.kind && old.size == child.size,
                    "Conflicting Hashtree child"
                );
            }
            children.insert(h, child);
        }
        ensure!(sum == parent.size, "Hashtree subtree length mismatch");
        let added = children
            .keys()
            .filter(|h| !r.links.contains_key(*h))
            .count();
        ensure!(
            self.count + added <= 1_000_000,
            "Resource proof limit reached"
        );
        r.links.extend(children);
        self.count += added;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secp256k1::{Keypair, SecretKey};
    fn fixture(root: &str, size: u64) -> (Vec<u8>, String) {
        let secp = Secp256k1::new();
        let key = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&[7; 32]).unwrap());
        let publisher = key.x_only_public_key().0.to_string();
        let mut event=Event{id:String::new(),pubkey:publisher.clone(),created_at:1000,kind:30064,tags:vec![vec!["expiration".into(),"2000".into()],vec!["l".into(),"hashtree".into()],vec!["t".into(),"atlas-map".into()],vec!["native-peer".into(),"peer".into()],vec!["hash".into(),root.into()],vec!["d".into(),"atlas/test".into()]],content:json!({"version":1,"nativeProfile":"atlas-native-v1","map":{"id":"test","url":format!("htree://{root}"),"bytes":size,"manifest":{"snapshot":"00".repeat(32),"name":"Test","bounds":[0,0,1,1],"minZoom":0,"maxZoom":16},"hashtree":{"version":1,"root":root,"bytes":size,"chunkBytes":16384,"providers":[]}}}).to_string(),sig:String::new()};
        let digest = event.digest().unwrap();
        event.id = hex::encode(digest);
        event.sig = secp
            .sign_schnorr_no_aux_rand(&Message::from_digest(digest), &key)
            .to_string();
        (serde_json::to_vec(&vec![event]).unwrap(), publisher)
    }
    #[test]
    fn rejects_signature_publisher_peer_expiry_and_ambiguous_catalog() {
        let (bytes, p) = fixture(&"00".repeat(32), 20000);
        assert!(Policy::discover(&bytes, &p, "peer", 1001).is_ok());
        assert!(Policy::discover(&bytes, &"11".repeat(32), "peer", 1001).is_err());
        assert!(Policy::discover(&bytes, &p, "other", 1001).is_err());
        assert!(Policy::discover(&bytes, &p, "peer", 2000).is_err());
        assert!(Policy::discover(&bytes, &p, "peer", 699).is_err());
        let mut events: Vec<Event> = serde_json::from_slice(&bytes).unwrap();
        events[0].sig = "00".repeat(64);
        assert!(Policy::discover(&serde_json::to_vec(&events).unwrap(), &p, "peer", 1001).is_err());
        let events: Vec<Event> = serde_json::from_slice(&bytes).unwrap();
        assert!(
            Policy::discover(
                &serde_json::to_vec(&vec![events[0].clone(), events[0].clone()]).unwrap(),
                &p,
                "peer",
                1001
            )
            .is_err()
        );
    }
    #[test]
    fn grants_membership_hash_and_expiry_are_independent() {
        #[derive(Serialize)]
        struct Child {
            #[serde(with = "serde_bytes")]
            h: Vec<u8>,
            s: u64,
            t: u8,
        }
        #[derive(Serialize)]
        struct Parent {
            l: Vec<Child>,
            t: u8,
        }
        let leaf = vec![42; 20000];
        let child = hex::encode(Sha256::digest(&leaf));
        let node = rmp_serde::to_vec_named(&Parent {
            l: vec![Child {
                h: hex::decode(&child).unwrap(),
                s: 20000,
                t: 0,
            }],
            t: 1,
        })
        .unwrap();
        let root = hex::encode(Sha256::digest(&node));
        let (catalog, p) = fixture(&root, 20000);
        let mut policy = Policy::discover(&catalog, &p, "peer", 1001).unwrap();
        assert!(policy.check(&root, &root, 1001).is_err());
        policy.select(&root, 1001).unwrap();
        assert!(policy.check(&root, &child, 1001).is_err());
        assert!(policy.accept(&root, &root, b"corrupt", 1001).is_err());
        assert!(policy.check(&root, &child, 1001).is_err());
        policy.accept(&root, &root, &node, 1001).unwrap();
        policy.accept(&root, &child, &leaf, 1001).unwrap();
        assert!(policy.check(&root, &child, 2000).is_err());
        assert!(policy.check(&child, &child, 1001).is_err());
        assert!(policy.select(&child, 1001).is_err());
    }
    #[test]
    fn malformed_tree_never_authorizes_children() {
        let node = rmp_serde::to_vec_named(&json!({"l":[],"t":1})).unwrap();
        let root = hex::encode(Sha256::digest(&node));
        let (c, p) = fixture(&root, 20000);
        let mut policy = Policy::discover(&c, &p, "peer", 1001).unwrap();
        policy.select(&root, 1001).unwrap();
        assert!(policy.accept(&root, &root, &node, 1001).is_err());
    }
    #[test]
    fn rejects_oversized_leaves_mismatched_lengths_and_trailing_node_data() {
        #[derive(Serialize)]
        struct Child {
            #[serde(with = "serde_bytes")]
            h: Vec<u8>,
            s: u64,
            t: u8,
        }
        #[derive(Serialize)]
        struct Parent {
            l: Vec<Child>,
            t: u8,
        }
        for (size, child_size, trailing) in [
            (20000, 19999, false),
            (MAX_BLOB as u64 + 1, MAX_BLOB as u64 + 1, false),
            (20000, 20000, true),
        ] {
            let child = "ab".repeat(32);
            let mut node = rmp_serde::to_vec_named(&Parent {
                l: vec![Child {
                    h: hex::decode(&child).unwrap(),
                    s: child_size,
                    t: 0,
                }],
                t: 1,
            })
            .unwrap();
            if trailing {
                node.push(0);
            }
            let root = hex::encode(Sha256::digest(&node));
            let (catalog, p) = fixture(&root, size);
            let mut policy = Policy::discover(&catalog, &p, "peer", 1001).unwrap();
            policy.select(&root, 1001).unwrap();
            assert!(policy.accept(&root, &root, &node, 1001).is_err());
            assert!(policy.check(&root, &child, 1001).is_err());
        }
    }
}
