fn main() -> Result<(), Box<dyn std::error::Error>> {
    // SAFETY: this single-threaded entry point has not initialized SQLite yet.
    // The callback only writes diagnostics and never calls SQLite.
    unsafe {
        rusqlite::trace::config_log(Some(|code, message| {
            // SQLITE_SCHEMA is an automatic reprepare, not a failed write.
            if code & 255 != rusqlite::ffi::SQLITE_SCHEMA {
                eprintln!("Source SQLite [{code}]: {message}");
            }
        }))?;
    }
    eprintln!("Source SQLite version {}", rusqlite::version());
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: source-store source.osm.pbf output.sqlite".into());
    }
    atlas_osm_import::import_source_store(&args[1], &args[2])
}
