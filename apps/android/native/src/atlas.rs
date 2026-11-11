//! Foreground native session. One authenticated physical connection, many blob streams.
use crate::{
    Request, SERVICE_PORT, config, download, download_frame, milliseconds,
    policy::{Policy, hash, now},
    pump,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use fips_core::{FipsEndpoint, PeerIdentity};
use fips_tcp_endpoint::FipsTcpEndpoint;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::Receiver,
    },
    time::{Duration, Instant},
};
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub transport: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub address: String,
    pub peer: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub catalog: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub publisher: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bootstrap: Option<Bootstrap>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bootstrap {
    pub peer: String,
    pub address: String,
}
impl Settings {
    pub fn validate(&self) -> Result<PeerIdentity> {
        let target = PeerIdentity::from_npub(&self.peer).context("Invalid map host npub")?;
        if let Some(seed) = &self.bootstrap {
            ensure!(
                self.address.is_empty() && self.catalog.is_empty() && self.publisher.is_empty(),
                "Choose npub discovery or legacy direct settings, not both"
            );
            Request {
                transport: self.transport.clone(),
                address: seed.address.clone(),
                peer: seed.peer.clone(),
                hash: "00".repeat(32),
            }
            .validate()?;
        } else {
            hash(&self.publisher)?;
            Request {
                transport: self.transport.clone(),
                address: self.address.clone(),
                peer: self.peer.clone(),
                hash: self.catalog.clone(),
            }
            .validate()?;
        }
        Ok(target)
    }
    pub fn trusted_publisher(&self) -> Result<String> {
        Ok(if self.bootstrap.is_some() {
            self.validate()?.pubkey().to_string()
        } else {
            self.publisher.clone()
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub id: u64,
    pub root: String,
    pub hash: String,
}
pub enum Input {
    Select(String),
    Blob(Command),
}
pub struct Link {
    endpoint: Arc<FipsEndpoint>,
    tcp: FipsTcpEndpoint,
    peer: PeerIdentity,
    start: Instant,
    pub bytes: u64,
    pub blobs: u64,
}
impl Link {
    pub async fn open(
        settings: &Settings,
        cancel: &AtomicBool,
        report: &mut impl FnMut(Value),
    ) -> Result<Self> {
        let peer = settings.validate()?;
        ensure!(!cancel.load(Ordering::Relaxed), "Cancelled");
        let mut c = config(&settings.transport, None)?;
        let seed_peer = settings
            .bootstrap
            .as_ref()
            .map_or(&settings.peer, |b| &b.peer);
        let seed_address = settings
            .bootstrap
            .as_ref()
            .map_or(&settings.address, |b| &b.address);
        let mut remote =
            fips_core::config::PeerConfig::new(seed_peer, &settings.transport, seed_address);
        remote.auto_reconnect = false;
        c.peers.push(remote);
        let endpoint = Arc::new(
            FipsEndpoint::builder()
                .config(c)
                .without_system_tun()
                .bind()
                .await?,
        );
        report(
            json!({"stage":"connecting","message":"Joining native FIPS through the pinned entry peer","carrier":settings.transport,"endpoint":seed_address,"bootstrap":seed_peer,"peer":settings.peer}),
        );
        let connected = bounded(cancel, async {
            loop {
                if let Some(p) = endpoint
                    .peers()
                    .await?
                    .into_iter()
                    .find(|p| p.connected && p.npub == *seed_peer)
                {
                    ensure!(
                        p.transport_type.as_deref() == Some(&settings.transport),
                        "Unexpected physical transport; no fallback allowed"
                    );
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            if settings.bootstrap.is_some() {
                report(json!({"stage":"resolving", "message":"Finding the map host by npub through FIPS", "peer":settings.peer}));
                endpoint.register_peer_identity(peer).await?;
                loop {
                    if let Some(next) = endpoint.resolve_next_hop(peer, None).await? {
                        report(json!({"stage":"route", "message":"Mesh route found; verifying the host's signed catalog", "peer":settings.peer,"nextHop":next.npub(),"carrier":settings.transport}));
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
            FipsTcpEndpoint::bind(
                endpoint.clone(),
                SERVICE_PORT,
                fips_tcp::Config::default(),
                0x41544c43,
            )
            .await
            .context("Open FIPS blob service")
        })
        .await;
        match connected {
            Ok(tcp) => {
                report(
                    json!({"stage":"connected","carrier":settings.transport,"peer":settings.peer,"message":"Native FIPS transport ready"}),
                );
                Ok(Self {
                    endpoint,
                    tcp,
                    peer,
                    start: Instant::now(),
                    bytes: 0,
                    blobs: 0,
                })
            }
            Err(e) => {
                let _ = tokio::time::timeout(Duration::from_secs(2), endpoint.shutdown()).await;
                Err(e)
            }
        }
    }
    pub async fn get(
        &mut self,
        h: &str,
        cancel: &AtomicBool,
        report: &mut impl FnMut(Value),
    ) -> Result<Vec<u8>> {
        let digest = hash(h)?;
        let id = self
            .tcp
            .connect(self.peer.clone(), milliseconds(self.start))
            .await?;
        let data = bounded(
            cancel,
            download(&mut self.tcp, id, &digest, self.start, report),
        )
        .await;
        match data {
            Ok(data) => {
                self.tcp.close(id, milliseconds(self.start)).await?;
                self.bytes += data.len() as u64;
                self.blobs += 1;
                Ok(data)
            }
            Err(e) => {
                let _ = self.tcp.abort(id).await;
                Err(e)
            }
        }
    }
    /// A well-known service request, validated against the host npub before it
    /// can create any resource grant. Ordinary blob reads always require SHA-256.
    pub async fn discover(
        &mut self,
        settings: &Settings,
        cancel: &AtomicBool,
        report: &mut impl FnMut(Value),
    ) -> Result<Policy> {
        if settings.bootstrap.is_none() {
            let bytes = self.get(&settings.catalog, cancel, report).await?;
            return Policy::discover(&bytes, &settings.publisher, &settings.peer, now());
        }
        let id = self
            .tcp
            .connect(self.peer, milliseconds(self.start))
            .await?;
        let result = bounded(cancel, async {
            let bytes = download_frame(&mut self.tcp, id, &[0; 32], 2, self.start, report).await?;
            let policy = Policy::discover(
                &bytes,
                &settings.trusted_publisher()?,
                &settings.peer,
                now(),
            )?;
            self.bytes += bytes.len() as u64;
            // Catalog signatures are verified, but this is not a content-addressed blob.
            Ok(policy)
        })
        .await;
        if result.is_ok() {
            self.tcp.close(id, milliseconds(self.start)).await?;
        } else {
            let _ = self.tcp.abort(id).await;
        }
        result
    }
    pub async fn close(&self) {
        let _ = tokio::time::timeout(Duration::from_secs(2), self.endpoint.shutdown()).await;
    }
}
async fn bounded<T>(
    cancel: &AtomicBool,
    f: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    ensure!(!cancel.load(Ordering::Relaxed), "Cancelled");
    tokio::select! {
        r=tokio::time::timeout(Duration::from_secs(25),f)=>r.context("Native FIPS timed out after 25 seconds. Check peer identity, numeric endpoint, selected transport and firewall; reconnect after changing networks.")?,
        _=async {while !cancel.load(Ordering::Relaxed){tokio::time::sleep(Duration::from_millis(20)).await;}}=>anyhow::bail!("Cancelled; native connection closed")
    }
}
pub async fn run(
    settings: Settings,
    receiver: Receiver<Input>,
    cancel: &AtomicBool,
    mut report: impl FnMut(Value),
) -> Result<()> {
    let mut link = Link::open(&settings, cancel, &mut report).await?;
    let operation=async {
        let mut policy=link.discover(&settings,cancel,&mut report).await?;
        report(json!({"stage":"catalog","offers":policy.offers,"carrier":settings.transport,"peer":settings.peer,"bytes":link.bytes,"blobs":link.blobs,"message":"Host identity and signed catalog verified. Choose a map to grant access."}));
        loop {
            ensure!(!cancel.load(Ordering::Relaxed),"Cancelled; native connection closed");
            match receiver.try_recv() {
                Ok(Input::Select(root))=>{policy.select(&root,now())?; let offer=policy.offers.iter().find(|o|o["hashtree"]["root"]==root).unwrap(); report(json!({"stage":"selected","offer":offer,"message":"Map resource grant active"}));},
                Ok(Input::Blob(command))=>{
                    if let Err(e)=policy.check(&command.root,&command.hash,now()) {
                        report(json!({"stage":"blob","id":command.id,"error":format!("{e:#}")}));continue;
                    }
                    let result=async {
                        let data=link.get(&command.hash,cancel,&mut report).await?;
                        policy.accept(&command.root,&command.hash,&data,now())?;
                        ensure!(!cancel.load(Ordering::Relaxed),"Cancelled");
                        Ok::<_,anyhow::Error>(data)
                    }.await;
                    match result {
                        Ok(data)=>report(json!({"stage":"blob","id":command.id,"data":STANDARD.encode(data),"bytes":link.bytes,"blobs":link.blobs,"carrier":settings.transport})),
                        Err(e)=>{report(json!({"stage":"blob","id":command.id,"error":format!("{e:#}")}));return Err(e);}
                    }
                },
                Err(std::sync::mpsc::TryRecvError::Disconnected)=>break,
                Err(std::sync::mpsc::TryRecvError::Empty)=>{pump(&mut link.tcp,link.start).await?;}
            }
        }
        Ok(())
    }.await;
    link.close().await;
    operation
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn npub_discovery_pins_catalog_signer_and_rejects_mixed_trust() {
        let endpoint = FipsEndpoint::builder()
            .config(config("tcp", None).unwrap())
            .without_system_tun()
            .bind()
            .await
            .unwrap();
        let peer = endpoint.npub().to_string();
        endpoint.shutdown().await.unwrap();
        let mut s = Settings {
            transport: "tcp".into(),
            peer: peer.clone(),
            address: String::new(),
            catalog: String::new(),
            publisher: String::new(),
            bootstrap: Some(Bootstrap {
                peer: peer.clone(),
                address: "127.0.0.1:42131".into(),
            }),
        };
        assert_eq!(
            s.trusted_publisher().unwrap(),
            PeerIdentity::from_npub(&peer).unwrap().pubkey().to_string()
        );
        s.publisher = "00".repeat(32);
        assert!(s.validate().is_err());
        s.publisher.clear();
        s.address = "127.0.0.1:42141".into();
        assert!(s.validate().is_err());
        s.address.clear();
        s.bootstrap.as_mut().unwrap().address = "host.example:1234".into();
        assert!(s.validate().is_err());
        s.bootstrap.as_mut().unwrap().address = "127.0.0.1:42131".into();
        s.transport = "websocket".into();
        assert!(s.validate().is_err());
        let mut value = serde_json::to_value(&s).unwrap();
        value["nsec"] = json!("not permitted");
        assert!(serde_json::from_value::<Settings>(value).is_err());
    }
}
