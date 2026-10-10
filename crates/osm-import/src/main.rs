fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 && !(args.len() == 4 && args[3] == "--no-legacy-routing") {
        return Err(
            "Usage: atlas-osm-import input.osm.pbf output.json [--no-legacy-routing]".into(),
        );
    }
    atlas_osm_import::import_display(&args[1], &args[2], args.len() == 3)
}
