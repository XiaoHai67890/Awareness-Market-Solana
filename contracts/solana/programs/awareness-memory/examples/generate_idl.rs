use anchor_lang_idl::build::IdlBuilder;

fn main() {
    // anchor-lang-idl 0.1.4 passes a literal "+{toolchain}" when this is set.
    // rust-toolchain.toml already selects our pinned toolchain in the child cwd.
    std::env::remove_var("RUSTUP_TOOLCHAIN");
    let program = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let idl = IdlBuilder::new()
        .program_path(program.clone())
        .cargo_args(vec!["--locked".into()])
        .build()
        .expect("compile Anchor IDL");
    let destination = program.join("../../idl/awareness_memory.json");
    std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
    std::fs::write(
        &destination,
        serde_json::to_string_pretty(&idl).unwrap() + "\n",
    )
    .unwrap();
    println!("{}", destination.display());
}
