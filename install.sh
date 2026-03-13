#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${OPENCLAW_DIY_REPO_URL:-https://github.com/bithcq/openclawdiy.git}"
DIY_DIR="${OPENCLAW_DIY_DIR:-$HOME/openclawdiy}"
TARGET_DIR="${OPENCLAW_TARGET_DIR:-$HOME/openclaw}"

info() {
  echo "[openclaw-diy] $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[openclaw-diy] ERROR: 缺少命令：$1" >&2
    exit 1
  }
}

require_cmd git
require_cmd node
require_cmd pnpm

if [[ -d "$DIY_DIR/.git" ]]; then
  info "更新 openclawdiy 仓库"
  git -C "$DIY_DIR" pull --ff-only origin main
elif [[ -e "$DIY_DIR" ]]; then
  echo "[openclaw-diy] ERROR: 目标目录已存在且不是 git 仓库：$DIY_DIR" >&2
  exit 1
else
  info "克隆 openclawdiy 仓库到 $DIY_DIR"
  git clone --depth 1 --branch main "$REPO_URL" "$DIY_DIR"
fi

info "开始套用 DIY 到 $TARGET_DIR"
exec bash "$DIY_DIR/scripts/install-diy.sh" "$TARGET_DIR"
