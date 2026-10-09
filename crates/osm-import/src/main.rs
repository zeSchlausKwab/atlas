fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: atlas-osm-import input.osm.pbf output.json".into());
    }
    atlas_osm_import::import_display(&args[1], &args[2])
}
