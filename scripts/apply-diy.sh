#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

require_cmd git
require_cmd node
require_cmd pnpm

TARGET_DIR="$(resolve_target_dir "${1:-}")"
ensure_official_repo "$TARGET_DIR"
prepare_target_repo "$TARGET_DIR"
reset_target_to_official_main "$TARGET_DIR"
persist_wecom_env
build_target "$TARGET_DIR"
install_wecom_deps
link_wecom_plugin "$TARGET_DIR"
warn_if_wecom_voice_deps_missing
configure_target_runtime "$TARGET_DIR"
install_or_restart_gateway_service "$TARGET_DIR"
print_final_status "$TARGET_DIR"
