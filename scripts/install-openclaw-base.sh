#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

TARGET_DIR="$(resolve_target_dir "${1:-}")"

ensure_system_prereqs
ensure_node_runtime
ensure_pnpm
require_cmd git
require_cmd node
require_cmd pnpm

ensure_official_repo "$TARGET_DIR"
prepare_target_repo "$TARGET_DIR"
reset_target_to_official_main "$TARGET_DIR"
build_target "$TARGET_DIR"
install_cli_wrapper "$TARGET_DIR"

info "官方底座已就绪：$TARGET_DIR"
