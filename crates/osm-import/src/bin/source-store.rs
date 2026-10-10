fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: source-store source.osm.pbf output.sqlite".into());
    }
    atlas_osm_import::import_source_store(&args[1], &args[2])
}
