#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

require_cmd git
require_cmd node
require_cmd pnpm

TARGET_DIR="$(resolve_target_dir "${1:-}")"
[[ -d "$TARGET_DIR/.git" ]] || die "目标目录不是官方 openclaw 仓库：$TARGET_DIR"

exec "$SCRIPT_DIR/apply-diy.sh" "$TARGET_DIR"
