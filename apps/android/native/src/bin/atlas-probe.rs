//! CLI acceptance probe using the exact Android native connection and policy.
use anyhow::{Context, Result};
use serde_json::json;
use soy_fips_demo::{
    atlas::{Link, Settings},
    policy::{Policy, now},
};
use std::sync::atomic::AtomicBool;
#[tokio::main]
async fn main() -> Result<()> {
    let s: Settings = serde_json::from_str(
        &std::env::args()
            .nth(1)
            .context("atlas-probe '<connection JSON>'")?,
    )?;
    let cancel = AtomicBool::new(false);
    let mut link = Link::open(&s, &cancel, &mut |e| println!("{e}")).await?;
    let result=async {
        let catalog=link.get(&s.catalog,&cancel,&mut |_|{}).await?;
        let mut policy=Policy::discover(&catalog,&s.publisher,&s.peer,now())?;
        let index=std::env::args().nth(2).map(|v|v.parse::<usize>()).transpose()?.unwrap_or(0);
        anyhow::ensure!(index<policy.offers.len(),"Map index out of range");
        println!("{}",json!({"stage":"catalog","maps":policy.offers.len(),"selected":policy.offers[index]["manifest"]["name"]}));
        let root=policy.offers[index]["hashtree"]["root"].as_str().unwrap().to_owned();
        anyhow::ensure!(policy.check(&root,&root,now()).is_err(),"Resource allowed before user grant");
        policy.select(&root,now())?;
        anyhow::ensure!(policy.check(&root,&"00".repeat(32),now()).is_err(),"Unrelated blob was authorized");
        let mut hash=root.clone();
        loop {
            policy.check(&root,&hash,now())?;
            let bytes=link.get(&hash,&cancel,&mut |_|{}).await?;
            policy.accept(&root,&hash,&bytes,now())?;
            #[derive(serde::Deserialize)]struct Node{l:Vec<Child>}
            #[derive(serde::Deserialize)]struct Child{#[serde(with="serde_bytes")]h:Vec<u8>}
            if let Ok(node)=rmp_serde::from_slice::<Node>(&bytes){hash=hex::encode(&node.l[0].h);}else{
                println!("{}",json!({"stage":"atlas-header","carrier":s.transport,"bytes":link.bytes,"blobs":link.blobs,"root":root,"headerHex":hex::encode(&bytes[..bytes.len().min(32)])}));break;
            }
        }
        for _ in 0..32 {let data=link.get(&root,&cancel,&mut |_|{}).await?;policy.accept(&root,&root,&data,now())?;}
        println!("{}",json!({"stage":"repeated-reads","blobs":link.blobs,"bytes":link.bytes}));
        Ok::<_,anyhow::Error>(())
    }.await;
    link.close().await;
    result
}
