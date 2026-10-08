use atlas_routing::{
    cells::{extract_cell, partition},
    Graph,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: partition-routing input.rte output-directory".into());
    }
    let graph = Graph::decode(&std::fs::read(&args[1])?)?;
    let groups = partition(&graph)?;
    std::fs::create_dir_all(&args[2])?;
    for (address, ids) in groups {
        let c = extract_cell(&graph, address, ids)?;
        std::fs::write(
            format!("{}/{}-{}.rcl", args[2], address.0, address.1),
            c.encode(),
        )?;
    }
    Ok(())
}
