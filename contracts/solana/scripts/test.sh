#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_root="${AWARENESS_SOLANA_TOOLING_DIR:-$project_dir/.local/tooling}"
export CARGO_HOME="$tool_root/cargo"
export RUSTUP_HOME="$tool_root/rustup"
export PATH="$CARGO_HOME/bin:$tool_root/solana-release/bin:$PATH"
"$project_dir/scripts/build.sh"
cd "$project_dir"
cargo fmt --all -- --check
cargo test --locked --features svm-tests
