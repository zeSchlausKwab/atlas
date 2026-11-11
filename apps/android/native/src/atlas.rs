//! Foreground native session. One authenticated physical connection, many blob streams.
use crate::{
    Request, SERVICE_PORT, config, download, milliseconds,
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
    pub address: String,
    pub peer: String,
    pub catalog: String,
    pub publisher: String,
}
impl Settings {
    pub fn validate(&self) -> Result<PeerIdentity> {
        hash(&self.catalog)?;
        hash(&self.publisher)?;
        Ok(Request {
            transport: self.transport.clone(),
            address: self.address.clone(),
            peer: self.peer.clone(),
            hash: self.catalog.clone(),
        }
        .validate()?
        .1)
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
        let mut remote = fips_core::config::PeerConfig::new(
            &settings.peer,
            &settings.transport,
            &settings.address,
        );
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
            json!({"stage":"connecting","message":"Authenticating pinned native peer","carrier":settings.transport,"endpoint":settings.address}),
        );
        let connected = bounded(cancel, async {
            loop {
                if let Some(p) = endpoint
                    .peers()
                    .await?
                    .into_iter()
                    .find(|p| p.connected && p.npub == peer.npub())
                {
                    ensure!(
                        p.transport_type.as_deref() == Some(&settings.transport),
                        "Unexpected physical transport; no fallback allowed"
                    );
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
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
                    json!({"stage":"connected","carrier":settings.transport,"peer":settings.peer,"message":"Pinned peer authenticated"}),
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
        let bytes=link.get(&settings.catalog,cancel,&mut report).await?;
        let mut policy=Policy::discover(&bytes,&settings.publisher,&settings.peer,now())?;
        report(json!({"stage":"catalog","offers":policy.offers,"carrier":settings.transport,"peer":settings.peer,"bytes":link.bytes,"blobs":link.blobs,"message":"Signed discovery verified. Choose a map to grant access."}));
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
