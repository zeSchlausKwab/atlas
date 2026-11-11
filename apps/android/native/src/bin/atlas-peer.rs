//! Isolated Atlas snapshot provider. Direct native TCP/UDP; no HTTP or WebSocket hop.
use anyhow::{Context, Result, ensure};
use fips_core::FipsEndpoint;
use fips_tcp::ConnectionId;
use fips_tcp_endpoint::FipsTcpEndpoint;
use serde_json::json;
use sha2::{Digest, Sha256};
use soy_fips_demo::{Request, SERVICE_PORT, config, milliseconds, pump};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("serve") => {
            let transport = args.get(2).map(String::as_str).unwrap_or("udp");
            let bind = args.get(3).map(String::as_str).unwrap_or("127.0.0.1:42121");
            let address = args.get(4).map(String::as_str).unwrap_or(bind);
            let corrupt = args.iter().any(|a| a == "--corrupt");
            serve(transport, bind, address, corrupt).await?;
        }
        _ => anyhow::bail!(
            "Usage: atlas-peer serve tcp|udp bind-IP:port visible-IP:port exported-directory [--corrupt] [--host-data /path/to/atlas/data]"
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
    let directory = std::env::args()
        .nth(5)
        .context("provide exported map directory after visible endpoint")?;
    let peer_secret = persistent_secret(&directory, &format!("peer-{transport}.key"))?;
    let endpoint = Arc::new(
        FipsEndpoint::builder()
            .config(config(transport, Some(bind))?)
            .identity_nsec(hex::encode(peer_secret))
            .without_system_tun()
            .bind()
            .await?,
    );
    let host_arg = std::env::args()
        .position(|a| a == "--host-data")
        .map(|n| {
            std::env::args()
                .nth(n + 1)
                .context("--host-data needs a path")
        })
        .transpose()?;
    let mut host_store = host_arg
        .map(|p| soy_fips_demo::host_store::HostStore::open(std::path::Path::new(&p)))
        .transpose()?;
    let offers: Vec<serde_json::Value> = if let Some(store) = &host_store {
        store.offers()
    } else {
        serde_json::from_slice(&std::fs::read(
            std::path::Path::new(&directory).join("offers.json"),
        )?)?
    };
    ensure!(
        !offers.is_empty() && offers.len() <= 16,
        "Expected 1–16 exported maps"
    );
    use secp256k1::{Keypair, Message, Secp256k1, SecretKey};
    let secret = persistent_secret(&directory, &format!("publisher-{transport}.key"))?;
    let secp = Secp256k1::new();
    let key = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&secret)?);
    let publisher = key.x_only_public_key().0.to_string();
    let time = soy_fips_demo::policy::now();
    let events: Vec<_> = offers
        .iter()
        .map(|offer| -> Result<_> {
            let mut event = soy_fips_demo::policy::Event {
                id: String::new(),
                pubkey: publisher.clone(),
                created_at: time,
                kind: 30064,
                tags: vec![
                    vec![
                        "d".into(),
                        format!("atlas/{}", offer["id"].as_str().context("Missing map id")?),
                    ],
                    vec!["l".into(), "hashtree".into()],
                    vec!["t".into(), "atlas-map".into()],
                    vec![
                        "hash".into(),
                        offer["hashtree"]["root"]
                            .as_str()
                            .context("Missing root")?
                            .into(),
                    ],
                    vec!["expiration".into(), (time + 7 * 86400).to_string()],
                    vec!["native-peer".into(), endpoint.npub().into()],
                ],
                content: json!({"version":1,"nativeProfile":"atlas-native-v1","map":offer})
                    .to_string(),
                sig: String::new(),
            };
            let digest = event.digest()?;
            event.id = hex::encode(digest);
            event.sig = secp
                .sign_schnorr_no_aux_rand(&Message::from_digest(digest), &key)
                .to_string();
            Ok(event)
        })
        .collect::<Result<_>>()?;
    let catalog_path = std::path::Path::new(&directory).join(format!("catalog-{transport}.json"));
    let previous = std::fs::read(&catalog_path).ok().filter(|b| {
        soy_fips_demo::policy::Policy::discover(b, &publisher, &endpoint.npub(), time)
            .is_ok_and(|p| p.offers == offers)
    });
    let payload = previous.unwrap_or(serde_json::to_vec(&events)?);
    std::fs::write(&catalog_path, &payload)?;
    let hash = hex::encode(Sha256::digest(&payload));
    let settings = soy_fips_demo::atlas::Settings {
        transport: transport.into(),
        address: address.into(),
        peer: endpoint.npub().into(),
        catalog: hash.clone(),
        publisher,
    };
    settings.validate()?;
    // Validate signed offers with the same policy before advertising the provider.
    soy_fips_demo::policy::Policy::discover(&payload, &settings.publisher, &settings.peer, time)?;
    let request = Request {
        transport: transport.into(),
        address: address.into(),
        peer: endpoint.npub().into(),
        hash,
    };
    request.validate()?;
    let public_config = serde_json::to_string(&settings)?;
    std::fs::write(
        std::path::Path::new(&directory).join(format!("connection-{transport}.json")),
        &public_config,
    )?;
    println!("{}", public_config);
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
                let handled=async {
                if state.request.len() < 36 {
                    state.request.extend(
                        tcp.read(id, 36 - state.request.len(), milliseconds(start))
                            .await?,
                    );
                    if state.request.len() == 36 {
                        ensure!(state.request[..4]==[0x48,1,1,0],"Only local Hashtree GET is supported");
                        let requested=hex::encode(&state.request[4..]);
                        let data=if requested==request.hash {Some(payload.clone())} else if let Some(store)=&mut host_store {store.get(&requested)?} else {
                            let path=std::path::Path::new(&directory).join("blobs").join(&requested);
                            match std::fs::metadata(&path) {
                                Ok(meta) if meta.is_file() && meta.len()<=soy_fips_demo::MAX_BLOB as u64 => Some(std::fs::read(path)?),
                                _=>None,
                            }
                        };
                        let mut data=data.unwrap_or_default();
                        let found=!data.is_empty();
                        if corrupt && requested!=request.hash && found {data[0]^=1;}
                        state.response=vec![0x48,1,if found{1}else{0}];
                        state.response.extend_from_slice(&(data.len() as u32).to_be_bytes());
                        state.response.extend_from_slice(&data);
                        eprintln!("{}",json!({"stage":"served","carrier":transport,"hash":requested,"bytes":data.len(),"found":found}));
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
                        remove.push(id); // TCP stack owns FIN/retransmission; release application buffers now.
                    }
                }
                Ok::<_,anyhow::Error>(())
                }.await;
                if let Err(e) = handled {
                    eprintln!(
                        "{}",
                        json!({"stage":"client-error","message":e.to_string()})
                    );
                    let _ = tcp.abort(id).await;
                    remove.push(id);
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

fn persistent_secret(directory: &str, name: &str) -> Result<[u8; 32]> {
    use std::io::{Read, Write};
    use std::os::unix::fs::OpenOptionsExt;
    let path = std::path::Path::new(directory).join(name);
    if path.exists() {
        let v = std::fs::read(&path)?;
        ensure!(v.len() == 32, "Invalid provider identity file");
        return Ok(v.try_into().unwrap());
    }
    let mut secret = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut secret)?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(&secret)?;
    f.sync_all()?;
    Ok(secret)
}
