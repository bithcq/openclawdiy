#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

TARGET_DIR="$(resolve_target_dir "${1:-}")"

bash "$SCRIPT_DIR/install-openclaw-base.sh" "$TARGET_DIR"
bash "$SCRIPT_DIR/install-diy.sh" "$TARGET_DIR"
