//! Local fixture / CLI client. Serves synthetic public bytes, never Atlas data.
use anyhow::{Context, Result, ensure};
use fips_core::FipsEndpoint;
use fips_tcp::ConnectionId;
use fips_tcp_endpoint::FipsTcpEndpoint;
use serde_json::json;
use sha2::{Digest, Sha256};
use soy_fips_demo::{Request, SERVICE_PORT, config, fetch, milliseconds, pump};
use std::{
    collections::HashMap,
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant},
};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("fetch") => {
            let request: Request = serde_json::from_str(
                args.get(2)
                    .context("fetch requires a public connection JSON argument")?,
            )?;
            let result = fetch(&request, &AtomicBool::new(false), |v| println!("{v}")).await?;
            println!("{result}");
        }
        Some("serve") => {
            let transport = args.get(2).map(String::as_str).unwrap_or("udp");
            let bind = args.get(3).map(String::as_str).unwrap_or("127.0.0.1:42121");
            let address = args.get(4).map(String::as_str).unwrap_or(bind);
            let corrupt = args.iter().any(|a| a == "--corrupt");
            serve(transport, bind, address, corrupt).await?;
        }
        _ => anyhow::bail!(
            "Usage: fips-demo serve [tcp|udp] [bind-IP:port] [client-visible-IP:port] [--corrupt]\n       fips-demo fetch '<public connection JSON>'"
        ),
    }
    Ok(())
}

struct Transfer {
    request: Vec<u8>,
    response: Vec<u8>,
    offset: usize,
    opened: Instant,
    closing: bool,
}

async fn serve(transport: &str, bind: &str, address: &str, corrupt: bool) -> Result<()> {
    // Validate before binding; this fixture never accepts hostname-based discovery.
    let _: std::net::SocketAddr = bind
        .parse()
        .context("Fixture bind must be numeric IP:port")?;
    let endpoint = Arc::new(
        FipsEndpoint::builder()
            .config(config(transport, Some(bind))?)
            .without_system_tun()
            .bind()
            .await?,
    );
    let text = b"Native FIPS on Android. This synthetic public resource travelled through an authenticated TCP/UDP peer and was verified with SHA-256. No DNS, WebSocket, STUN, TURN or VPN is required for this direct connection.\n";
    let mut payload = text.repeat(1280);
    let hash = hex::encode(Sha256::digest(&payload));
    if corrupt {
        payload[0] ^= 1;
    }
    let request = Request {
        transport: transport.into(),
        address: address.into(),
        peer: endpoint.npub().into(),
        hash,
    };
    request.validate()?;
    println!("{}", serde_json::to_string(&request)?);
    let mut tcp = FipsTcpEndpoint::bind(
        endpoint.clone(),
        SERVICE_PORT,
        fips_tcp::Config::default(),
        0x534f5953,
    )
    .await?;
    let start = Instant::now();
    let mut active: HashMap<ConnectionId, Transfer> = HashMap::new();
    let operation = async {
        loop {
            pump(&mut tcp, start).await?;
            while let Some(id) = tcp.accept() {
                if active.len() >= 8 {
                    tcp.abort(id).await?;
                    continue;
                }
                active.insert(
                    id,
                    Transfer {
                        request: Vec::new(),
                        response: Vec::new(),
                        offset: 0,
                        opened: Instant::now(),
                        closing: false,
                    },
                );
            }
            let mut remove = Vec::new();
            for (&id, state) in active.iter_mut() {
                if tcp.state(id).is_none() {
                    remove.push(id);
                    continue;
                }
                if state.opened.elapsed() > Duration::from_secs(30) {
                    let _ = tcp.abort(id).await;
                    remove.push(id);
                    continue;
                }
                if state.request.len() < 36 {
                    state.request.extend(
                        tcp.read(id, 36 - state.request.len(), milliseconds(start))
                            .await?,
                    );
                    if state.request.len() == 36 {
                        ensure!(
                            state.request[..4] == [0x48, 1, 1, 0],
                            "Fixture only accepts local Hashtree GET requests"
                        );
                        let found = state.request[4..] == hex::decode(&request.hash)?;
                        state.response = vec![0x48, 1, if found { 1 } else { 0 }];
                        state.response.extend_from_slice(
                            &(if found { payload.len() as u32 } else { 0 }).to_be_bytes(),
                        );
                        if found {
                            state.response.extend_from_slice(&payload);
                        }
                    }
                }
                if !state.response.is_empty() && !state.closing {
                    let end = (state.offset + 16384).min(state.response.len());
                    state.offset += tcp
                        .write(id, &state.response[state.offset..end], milliseconds(start))
                        .await?;
                    if state.offset == state.response.len() {
                        tcp.close(id, milliseconds(start)).await?;
                        state.closing = true;
                    }
                }
            }
            for id in remove {
                active.remove(&id);
            }
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    let result = tokio::select! { v = operation => v, _ = tokio::signal::ctrl_c() => Ok(()) };
    endpoint.shutdown().await?;
    eprintln!("{}", json!({"stage":"closed"}));
    result
}
