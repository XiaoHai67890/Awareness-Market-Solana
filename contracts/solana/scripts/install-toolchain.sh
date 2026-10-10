#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_root="${1:-$project_dir/.local/tooling}"
mkdir -p "$tool_root"
tool_root="$(cd "$tool_root" && pwd)"
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) rust_target=aarch64-apple-darwin; agave_target=aarch64-apple-darwin; platform_target=osx-aarch64 ;;
  Darwin/x86_64) rust_target=x86_64-apple-darwin; agave_target=x86_64-apple-darwin; platform_target=osx-x86_64 ;;
  Linux/x86_64) rust_target=x86_64-unknown-linux-gnu; agave_target=x86_64-unknown-linux-gnu; platform_target=linux-x86_64 ;;
  *) echo "Unsupported host; install Agave 3.0.13 and platform-tools v1.52 manually." >&2; exit 1 ;;
esac
export CARGO_HOME="$tool_root/cargo"
export RUSTUP_HOME="$tool_root/rustup"
export PATH="$CARGO_HOME/bin:$PATH"

if [[ ! -x "$CARGO_HOME/bin/rustup" ]]; then
  curl --fail --location --retry 3 "https://static.rust-lang.org/rustup/archive/1.29.1/$rust_target/rustup-init" -o "$tool_root/rustup-init"
  chmod +x "$tool_root/rustup-init"
  "$tool_root/rustup-init" -y --no-modify-path --profile minimal --default-toolchain 1.90.0
fi
rustup toolchain install 1.90.0 --profile minimal --component rustfmt
if [[ ! -x "$tool_root/solana-release/bin/cargo-build-sbf" ]]; then
  curl --fail --location --retry 3 "https://github.com/anza-xyz/agave/releases/download/v3.0.13/solana-release-$agave_target.tar.bz2" -o "$tool_root/agave-3.0.13.tar.bz2"
  tar -xjf "$tool_root/agave-3.0.13.tar.bz2" -C "$tool_root"
fi
platform_dir="$tool_root/solana-release/bin/platform-tools-sdk/sbf/dependencies/platform-tools"
if [[ ! -f "$platform_dir/.awareness-v1.52" ]]; then
  if [[ -e "$platform_dir" ]]; then
    echo "Existing platform-tools lack the v1.52 marker. Choose a fresh tool directory." >&2
    exit 1
  fi
  curl --fail --location --retry 3 "https://github.com/anza-xyz/platform-tools/releases/download/v1.52/platform-tools-$platform_target.tar.bz2" -o "$tool_root/platform-tools-v1.52.tar.bz2"
  mkdir -p "$platform_dir"
  tar -xjf "$tool_root/platform-tools-v1.52.tar.bz2" -C "$platform_dir"
  touch "$platform_dir/.awareness-v1.52"
fi
sdk_scripts="$tool_root/solana-release/bin/platform-tools-sdk/sbf/scripts"
if [[ ! -e "$sdk_scripts/install.vendor.sh" ]]; then
  mv "$sdk_scripts/install.sh" "$sdk_scripts/install.vendor.sh"
  cat > "$sdk_scripts/install.sh" <<'WRAPPER'
#!/usr/bin/env bash
# Agave strip.sh invokes install.sh even with cargo-build-sbf --skip-tools-install.
if [[ "${AWARENESS_SBF_SKIP_SDK_INSTALL:-}" == "1" ]]; then exit 0; fi
exec bash "$(dirname "$0")/install.vendor.sh" "$@"
WRAPPER
  chmod +x "$sdk_scripts/install.sh"
fi
echo "Set AWARENESS_SOLANA_TOOLING_DIR=$tool_root before build.sh or test.sh."
