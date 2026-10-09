fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: transport-import source.osm.pbf output-directory".into());
    }
    atlas_osm_import::import_transport(&args[1], &args[2])
}
