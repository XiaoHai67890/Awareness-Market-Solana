# Source this file in bash or zsh; it affects only the current shell.
if [ -n "${BASH_VERSION:-}" ]; then
  awareness_env_file="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  awareness_env_file="${(%):-%N}"
else
  echo "Source scripts/env.sh from bash or zsh." >&2
  return 1
fi
awareness_program_dir="$(cd "$(dirname "$awareness_env_file")/.." && pwd)"
export AWARENESS_SOLANA_TOOLING_DIR="${AWARENESS_SOLANA_TOOLING_DIR:-$awareness_program_dir/.local/tooling}"
export CARGO_HOME="$AWARENESS_SOLANA_TOOLING_DIR/cargo"
export RUSTUP_HOME="$AWARENESS_SOLANA_TOOLING_DIR/rustup"
export PATH="$CARGO_HOME/bin:$AWARENESS_SOLANA_TOOLING_DIR/solana-release/bin:$PATH"
unset awareness_env_file awareness_program_dir
