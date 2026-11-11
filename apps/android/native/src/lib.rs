//! Native TCP/UDP core. No browser networking, DNS, relay discovery or TUN.
use anyhow::{Context, Result, bail, ensure};
use fips_core::{Config, FipsEndpoint, PeerIdentity};
use fips_tcp::{ConnectionId, State};
use fips_tcp_endpoint::FipsTcpEndpoint;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub const SERVICE_PORT: u16 = 39018;
pub const MAX_BLOB: usize = 2 * 1024 * 1024;
pub const DEADLINE: Duration = Duration::from_secs(25);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub transport: String,
    pub address: String,
    pub peer: String,
    pub hash: String,
}

impl Request {
    pub fn validate(&self) -> Result<([u8; 32], PeerIdentity)> {
        ensure!(
            matches!(self.transport.as_str(), "tcp" | "udp"),
            "Choose TCP or UDP"
        );
        let addr: SocketAddr = self.address.parse().context(
            "Enter a numeric IP:port (IPv6 uses [address]:port); DNS is deliberately disabled",
        )?;
        ensure!(
            addr.port() != 0 && !addr.ip().is_unspecified() && !addr.ip().is_multicast(),
            "Enter a reachable unicast IP and nonzero port"
        );
        let peer = PeerIdentity::from_npub(&self.peer)
            .context("Invalid peer public identity; paste the fixture's npub")?;
        let hash: [u8; 32] = hex::decode(&self.hash)
            .context("Invalid SHA-256 hex")?
            .try_into()
            .map_err(|_| anyhow::anyhow!("SHA-256 must contain exactly 64 hex characters"))?;
        Ok((hash, peer))
    }
}

pub fn config(transport: &str, listen: Option<&str>) -> Result<Config> {
    ensure!(
        matches!(transport, "tcp" | "udp"),
        "Only TCP and UDP are supported"
    );
    let adapter = if transport == "udp" {
        json!({"bind_addr":listen.unwrap_or("0.0.0.0:0"), "outbound_only":listen.is_none(), "advertise_on_nostr":false})
    } else {
        json!({"bind_addr":listen, "advertise_on_nostr":false})
    };
    let mut transports = serde_json::Map::new();
    transports.insert(transport.into(), adapter);
    Ok(serde_json::from_value(json!({
        "node": {"identity":{"persistent":false}, "leaf_only":true,
          "system_files_enabled":false,
          "discovery":{"nostr":{"enabled":false}, "lan":{"enabled":false}, "local":{"enabled":false}}},
        "tun":{"enabled":false}, "dns":{"enabled":false}, "transports":transports
    }))?)
}

pub fn milliseconds(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

pub async fn pump(tcp: &mut FipsTcpEndpoint, start: Instant) -> Result<()> {
    tcp.poll(milliseconds(start))
        .await
        .context("Poll FIPS stream")?;
    match tokio::time::timeout(Duration::from_millis(10), tcp.receive(milliseconds(start))).await {
        Ok(result) => {
            result.context("Receive FIPS stream")?;
        }
        Err(_) => {} // An idle receive is normal; the whole operation has a deadline.
    }
    Ok(())
}

pub fn response_size(header: &[u8]) -> Result<usize> {
    ensure!(
        header.len() == 7 && header[..2] == [0x48, 1],
        "Invalid Hashtree blob response header"
    );
    let size = u32::from_be_bytes(header[3..7].try_into()?) as usize;
    match header[2] {
        0 => {
            ensure!(size == 0, "Malformed missing-blob response");
            bail!("The authenticated peer does not have this blob. Check the hash or provider.");
        }
        1 => {
            ensure!(
                size <= MAX_BLOB,
                "Blob exceeds this demo's 2 MiB resource limit"
            );
            Ok(size)
        }
        _ => bail!("Unknown Hashtree blob response status"),
    }
}

pub fn verify(data: &[u8], hash: &[u8; 32]) -> Result<()> {
    ensure!(
        Sha256::digest(data).as_slice() == hash,
        "SHA-256 mismatch: unverified bytes were discarded"
    );
    Ok(())
}

/// Endpoint shutdown runs on success, cancellation, timeout and protocol failure.
pub async fn fetch(
    request: &Request,
    cancel: &AtomicBool,
    mut report: impl FnMut(Value),
) -> Result<Value> {
    let (hash, peer) = request.validate()?;
    ensure!(!cancel.load(Ordering::Relaxed), "Cancelled");
    report(
        json!({"stage":"connecting", "message":format!("Opening native {} to {}", request.transport.to_uppercase(), request.address)}),
    );
    let mut settings = config(&request.transport, None)?;
    let mut remote =
        fips_core::config::PeerConfig::new(&request.peer, &request.transport, &request.address);
    remote.auto_reconnect = false;
    settings.peers.push(remote);
    let endpoint = Arc::new(
        FipsEndpoint::builder()
            .config(settings)
            .without_system_tun()
            .bind()
            .await
            .context("Start native FIPS endpoint")?,
    );
    let local = endpoint.npub().to_string();
    report(
        json!({"stage":"authenticating", "message":"Authenticating the pinned peer with FIPS", "local":local}),
    );
    let started = Instant::now();
    let operation = async {
        loop {
            if let Some(link) = endpoint
                .peers()
                .await?
                .into_iter()
                .find(|p| p.connected && p.npub == peer.npub())
            {
                ensure!(
                    link.transport_type.as_deref() == Some(request.transport.as_str()),
                    "Unexpected carrier; refusing a transport fallback"
                );
                report(
                    json!({"stage":"connected", "message":format!("Authenticated over native {}",request.transport.to_uppercase()), "peer":link.npub, "carrier":link.transport_type}),
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let mut tcp = FipsTcpEndpoint::bind(
            endpoint.clone(),
            SERVICE_PORT,
            fips_tcp::Config::default(),
            0x534f5944,
        )
        .await?;
        let id = tcp
            .connect(peer, milliseconds(started))
            .await
            .context("Open reliable FIPS blob stream")?;
        let result = download(&mut tcp, id, &hash, started, &mut report).await;
        if result.is_ok() {
            tcp.close(id, milliseconds(started)).await?;
        } else {
            let _ = tcp.abort(id).await;
        }
        result
    };
    let result = tokio::select! {
        outcome = tokio::time::timeout(DEADLINE, operation) => outcome.context("FIPS transfer timed out after 25 seconds; check the peer identity, IP, transport and firewall").and_then(|v| v),
        _ = async { while !cancel.load(Ordering::Relaxed) { tokio::time::sleep(Duration::from_millis(20)).await; } } => Err(anyhow::anyhow!("Cancelled")),
    };
    let shutdown = tokio::time::timeout(Duration::from_secs(2), endpoint.shutdown()).await;
    // Cleanup failures must not hide the useful original failure.
    match result {
        Err(error) => Err(error),
        Ok(data) => {
            shutdown
                .context("Timed out closing native endpoint")?
                .context("Close native endpoint")?;
            Ok(
                json!({"stage":"complete", "message":"SHA-256 verified · connection closed", "carrier":request.transport, "bytes":data.len(), "hash":request.hash, "elapsed_ms":milliseconds(started), "local":local,
                "preview":String::from_utf8_lossy(&data[..data.len().min(512)])}),
            )
        }
    }
}

async fn download(
    tcp: &mut FipsTcpEndpoint,
    id: ConnectionId,
    hash: &[u8; 32],
    start: Instant,
    report: &mut impl FnMut(Value),
) -> Result<Vec<u8>> {
    while tcp.state(id) != Some(State::Established) {
        pump(tcp, start).await?;
    }
    let mut request = vec![0x48, 1, 1, 0]; // GET, HTL 0: this provider only.
    request.extend_from_slice(hash);
    let mut sent = 0;
    while sent < request.len() {
        sent += tcp.write(id, &request[sent..], milliseconds(start)).await?;
        pump(tcp, start).await?;
    }
    let mut header = Vec::new();
    while header.len() < 7 {
        header.extend(tcp.read(id, 7 - header.len(), milliseconds(start)).await?);
        if header.len() < 7 {
            ensure!(
                !tcp.is_read_closed(id),
                "Peer closed before response header"
            );
            pump(tcp, start).await?;
        }
    }
    let size = response_size(&header)?;
    let mut data = Vec::with_capacity(size);
    let mut last = Instant::now() - Duration::from_secs(1);
    while data.len() < size {
        data.extend(
            tcp.read(id, (size - data.len()).min(65536), milliseconds(start))
                .await?,
        );
        if last.elapsed() > Duration::from_millis(150) {
            report(
                json!({"stage":"receiving", "message":format!("Receiving {} / {} bytes", data.len(),size), "received":data.len(), "total":size}),
            );
            last = Instant::now();
        }
        if data.len() < size {
            ensure!(
                !tcp.is_read_closed(id),
                "Peer closed before the complete blob arrived"
            );
            pump(tcp, start).await?;
        }
    }
    verify(&data, hash)?;
    Ok(data)
}

#[cfg(target_os = "android")]
mod android;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_bad_or_oversized_responses_and_corrupt_content() {
        assert!(response_size(&[0x48, 1, 1, 0, 0, 0, 3]).is_ok());
        assert!(
            response_size(&[0x48, 1, 0, 0, 0, 0, 0])
                .unwrap_err()
                .to_string()
                .contains("does not have")
        );
        assert!(response_size(&[0x48, 1, 1, 0xff, 0xff, 0xff, 0xff]).is_err());
        assert!(response_size(&[0, 1, 1, 0, 0, 0, 3]).is_err());
        assert!(verify(b"changed", &Sha256::digest(b"original").into()).is_err());
    }
    #[test]
    fn only_selected_carrier_without_system_networking_or_discovery() {
        for transport in ["tcp", "udp"] {
            let c = config(transport, None).unwrap();
            assert_eq!(
                c.transports.instance_counts().collect::<Vec<_>>(),
                vec![(transport, 1)]
            );
            assert!(!c.tun.enabled && !c.dns.enabled && !c.node.identity.persistent);
            assert!(
                !c.node.discovery.nostr.enabled
                    && !c.node.discovery.lan.enabled
                    && !c.node.discovery.local.enabled
            );
        }
    }

    #[tokio::test]
    async fn cancellation_closes_an_unreachable_connection_promptly() {
        let identity = FipsEndpoint::builder()
            .without_system_tun()
            .bind()
            .await
            .unwrap();
        let peer = identity.npub().to_string();
        identity.shutdown().await.unwrap();
        let request = Request {
            transport: "udp".into(),
            address: "127.0.0.1:9".into(),
            peer,
            hash: "00".repeat(32),
        };
        let cancel = AtomicBool::new(false);
        let start = Instant::now();
        let outcome = fetch(&request, &cancel, |event| {
            if event["stage"] == "authenticating" {
                cancel.store(true, Ordering::SeqCst);
            }
        })
        .await;
        assert!(outcome.unwrap_err().to_string().contains("Cancelled"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}

pub mod atlas;
pub mod policy;
