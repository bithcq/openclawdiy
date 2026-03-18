#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${OPENCLAW_DIY_REPO_URL:-https://github.com/bithcq/openclawdiy.git}"
DIY_DIR="${OPENCLAW_DIY_DIR:-$HOME/openclawdiy}"
TARGET_DIR="${OPENCLAW_TARGET_DIR:-$HOME/openclaw}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[openclaw-diy] ERROR: 缺少命令：$1" >&2
    exit 1
  }
}

require_cmd git

if [[ -d "$DIY_DIR/.git" ]]; then
  git -C "$DIY_DIR" fetch origin main
  git -C "$DIY_DIR" reset --hard origin/main
elif [[ -e "$DIY_DIR" ]]; then
  echo "[openclaw-diy] ERROR: 目标目录已存在且不是 git 仓库：$DIY_DIR" >&2
  exit 1
else
  git clone --depth 1 --branch main "$REPO_URL" "$DIY_DIR"
fi

exec bash "$DIY_DIR/scripts/install-openclaw-base.sh" "$TARGET_DIR"
