//! Explicit native ingress peers for a host behind NAT. No transport fallback.
use anyhow::{Result, ensure};
use fips_core::{Config, FipsEndpoint};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashSet, path::Path};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Uplink {
    pub peer: String,
    pub transport: String,
    pub address: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Uplinks {
    pub peers: Vec<Uplink>,
}

impl Uplinks {
    pub fn apply(&self, config: Config) -> Result<Config> {
        ensure!(
            self.peers.len() <= 8,
            "At most eight explicit native entry peers"
        );
        let mut seen = HashSet::new();
        let mut value = serde_json::to_value(config)?;
        for peer in &self.peers {
            crate::Request {
                transport: peer.transport.clone(),
                address: peer.address.clone(),
                peer: peer.peer.clone(),
                hash: "00".repeat(32),
            }
            .validate()?;
            ensure!(
                seen.insert(&peer.peer),
                "Configure each entry identity once"
            );
            // Preserve the existing LAN listener. Additional adapters dial out only.
            if value["transports"].get(&peer.transport).is_none() {
                value["transports"][&peer.transport] = if peer.transport == "udp" {
                    json!({"bind_addr":"0.0.0.0:0","outbound_only":true,"advertise_on_nostr":false})
                } else {
                    json!({"advertise_on_nostr":false})
                };
            }
        }
        let mut config: Config = serde_json::from_value(value)?;
        for peer in &self.peers {
            ensure!(
                !config.peers.iter().any(|p| p.npub == peer.peer),
                "Entry duplicates the primary bootstrap"
            );
            config.peers.push(fips_core::config::PeerConfig::new(
                &peer.peer,
                &peer.transport,
                &peer.address,
            ));
        }
        Ok(config)
    }

    /// A fresh authenticated link is necessary, but not proof of end-to-end map delivery.
    pub async fn write_status(&self, endpoint: &FipsEndpoint, directory: &Path) -> Result<()> {
        let observed = endpoint.peers().await?;
        let peers: Vec<_> = self
            .peers
            .iter()
            .map(|expected| {
                let active = observed
                    .iter()
                    .find(|p| p.npub == expected.peer && p.connected);
                let actual = active.and_then(|p| p.transport_type.as_deref());
                json!({"peer":expected.peer,"endpoint":expected.address,
                "expectedTransport":expected.transport,"actualTransport":actual,
                "authenticated":actual == Some(expected.transport.as_str())})
            })
            .collect();
        let payload = json!({"version":1,"checkedAtUnix":crate::policy::now(),
            "provider":endpoint.npub(),"peers":peers,"endToEndVerified":false,
            "note":"Entry link health only; run atlas-probe through a public entry to verify map reads."});
        let part = directory.join("uplinks-status.json.part");
        std::fs::write(&part, serde_json::to_vec(&payload)?)?;
        std::fs::rename(part, directory.join("uplinks-status.json"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PEER: &str = "npub1zv3qmj7xz7znehyqwzpc26fcjxtcf7tpxeevxx93ymgm6kw7gjpqp9npvh";
    fn entry(transport: &str, address: &str) -> Uplink {
        Uplink {
            peer: PEER.into(),
            transport: transport.into(),
            address: address.into(),
        }
    }
    #[test]
    fn outbound_udp_preserves_tcp_listener_and_disables_alternatives() {
        let c = Uplinks {
            peers: vec![entry("udp", "65.109.48.91:51820")],
        }
        .apply(crate::config("tcp", Some("127.0.0.1:42141")).unwrap())
        .unwrap();
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["transports"]["tcp"]["bind_addr"], "127.0.0.1:42141");
        assert_eq!(v["transports"]["udp"]["outbound_only"], true);
        assert_eq!(c.transports.instance_counts().count(), 2);
        assert!(!c.tun.enabled && !c.dns.enabled && !c.node.discovery.nostr.enabled);
        assert!(c.node.leaf_only && c.peers[0].auto_reconnect);
    }
    #[test]
    fn rejects_fallbacks_hostnames_unknown_fields_and_duplicate_pins() {
        for peer in [
            entry("websocket", "wss://example.test/fips"),
            entry("udp", "example.test:1234"),
            entry("udp", "0.0.0.0:1234"),
        ] {
            assert!(
                Uplinks { peers: vec![peer] }
                    .apply(crate::config("tcp", None).unwrap())
                    .is_err()
            );
        }
        assert!(serde_json::from_str::<Uplinks>(r#"{"peers":[],"fallback":"http"}"#).is_err());
        assert!(
            Uplinks {
                peers: vec![entry("udp", "127.0.0.1:1"), entry("tcp", "127.0.0.1:2")]
            }
            .apply(crate::config("tcp", None).unwrap())
            .is_err()
        );
    }
}
