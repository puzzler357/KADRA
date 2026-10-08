fn main() {
    // A release build that trusts no signing key rejects every licence and
    // opens every customer's database read-only. Stop it here instead: run
    // `node tools/kdr-license keygen --kid kdr-2026-1` and the key lands in
    // license-keys.json. (The dev key in license-keys.dev.json is compiled
    // into debug builds only.)
    println!("cargo:rerun-if-changed=license-keys.json");
    println!("cargo:rerun-if-changed=schema.json");
    println!("cargo:rerun-if-env-changed=LICENSE_SERVER_URL");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        // The licence server's address is compiled in (LICENSING.md 5.2). A
        // release without it could never activate or refresh online; one over
        // plain HTTP would send every request past anyone on the network.
        match std::env::var("LICENSE_SERVER_URL") {
            Ok(url) if url.starts_with("https://") => {}
            Ok(url) => panic!("LICENSE_SERVER_URL must be https://, got {url}"),
            Err(_) => panic!(
                "Set LICENSE_SERVER_URL (e.g. https://license.example.com/v1) for a release build."
            ),
        }

        let keys = std::fs::read_to_string("license-keys.json").unwrap_or_default();
        let listed = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&keys)
            .map(|keys| keys.keys().any(|kid| kid != "dev"))
            .unwrap_or(false);
        if !listed {
            panic!(
                "license-keys.json lists no release signing key. \
                 Generate one with `node tools/kdr-license keygen --kid kdr-2026-1` before a release build."
            );
        }
    }

    tauri_build::build()
}
