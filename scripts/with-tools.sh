#!/bin/sh
# Use project-local build tools when present; otherwise use the system tools.
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -d "$project_root/.tools/node/bin" ]; then
  PATH="$project_root/.tools/node/bin:$PATH"
fi
if [ -d "$project_root/.tools/cargo/bin" ]; then
  CARGO_HOME="$project_root/.tools/cargo"
  RUSTUP_HOME="$project_root/.tools/rustup"
  PATH="$CARGO_HOME/bin:$PATH"
  export CARGO_HOME RUSTUP_HOME
fi
export PATH
exec "$@"
