#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_root="${AWARENESS_SOLANA_TOOLING_DIR:-$project_dir/.local/tooling}"
export CARGO_HOME="$tool_root/cargo"
export RUSTUP_HOME="$tool_root/rustup"
export PATH="$CARGO_HOME/bin:$tool_root/solana-release/bin:$PATH"
export AWARENESS_SBF_SKIP_SDK_INSTALL=1
platform_dir="$tool_root/solana-release/bin/platform-tools-sdk/sbf/dependencies/platform-tools"
if [[ ! -x "$platform_dir/rust/bin/rustc" || ! -x "$tool_root/solana-release/bin/cargo-build-sbf" ]]; then
  echo "Run scripts/install-toolchain.sh first (or select AWARENESS_SOLANA_TOOLING_DIR)." >&2
  exit 1
fi
if [[ "$(cargo-build-sbf --version | head -n 1)" != "solana-cargo-build-sbf 3.0.13" ]]; then
  echo "Expected Agave cargo-build-sbf 3.0.13." >&2; exit 1
fi
if [[ "$("$platform_dir/rust/bin/rustc" --version)" != "rustc 1.89.0"* ]]; then
  echo "Expected platform-tools v1.52 / SBF Rust 1.89.0." >&2; exit 1
fi
cd "$project_dir"
# Populate Cargo metadata using the modern host Cargo, before SBF's compiler.
cargo metadata --locked --format-version 1 > /dev/null
output_dir="$(mktemp -d "${TMPDIR:-/tmp}/awareness-sbf.XXXXXX")"
trap 'rm -rf "$output_dir"' EXIT
# cargo-build-sbf creates a program keypair beside its ELF. Keep that unused
# keypair ephemeral; the program address is the declare_id! in the source.
RUSTC="$platform_dir/rust/bin/rustc" cargo-build-sbf \
  --manifest-path programs/awareness-memory/Cargo.toml --sbf-out-dir "$output_dir" \
  --tools-version v1.52 --skip-tools-install --no-rustup-override -- --locked
mkdir -p target/deploy
cp "$output_dir/awareness_memory.so" target/deploy/awareness_memory.so
cargo run --locked --example generate_idl
cargo run --locked --example generate_abi
echo "Built target/deploy/awareness_memory.so and regenerated IDL + ABI fixtures."
