#!/usr/bin/env bash
set -euo pipefail

DIY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_TARGET_DIR="${OPENCLAW_TARGET_DIR:-$HOME/openclaw}"
OFFICIAL_REMOTE_NAME="${OPENCLAW_OFFICIAL_REMOTE_NAME:-origin}"
OFFICIAL_REMOTE_URL="${OPENCLAW_OFFICIAL_REMOTE_URL:-https://github.com/openclaw/openclaw.git}"

info() {
  printf '[openclaw-diy] %s\n' "$*"
}

warn() {
  printf '[openclaw-diy] WARN: %s\n' "$*" >&2
}

die() {
  printf '[openclaw-diy] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

resolve_target_dir() {
  local input="${1:-$DEFAULT_TARGET_DIR}"
  if [[ "$input" == "~/"* ]]; then
    printf '%s\n' "$HOME/${input#~/}"
    return
  fi
  printf '%s\n' "$input"
}

ensure_official_repo() {
  local target_dir="$1"
  if [[ ! -d "$target_dir/.git" ]]; then
    info "克隆官方仓库到 $target_dir"
    git clone --depth 1 --branch main "$OFFICIAL_REMOTE_URL" "$target_dir"
    return
  fi

  local remote_url
  remote_url="$(git -C "$target_dir" remote get-url "$OFFICIAL_REMOTE_NAME" 2>/dev/null || true)"
  if [[ -z "$remote_url" ]]; then
    die "目标目录存在 git 仓库，但没有远端 $OFFICIAL_REMOTE_NAME"
  fi
  if [[ "$remote_url" != *"openclaw/openclaw"* ]]; then
    die "目标仓库的 $OFFICIAL_REMOTE_NAME 不是官方 openclaw/openclaw：$remote_url"
  fi
}

prepare_target_repo() {
  local target_dir="$1"
  if ! git -C "$target_dir" diff --quiet || \
     ! git -C "$target_dir" diff --cached --quiet || \
     [[ -n "$(git -C "$target_dir" ls-files --others --exclude-standard)" ]]; then
    warn "目标仓库存在本地改动；DIY 会把它当作可重建目录并覆盖。"
  fi
}

remove_previous_overlay_paths() {
  local target_dir="$1"
  while IFS= read -r src; do
    local rel="${src#"$DIY_ROOT/overlay/"}"
    rm -f "$target_dir/$rel"
  done < <(find "$DIY_ROOT/overlay" -type f | sort)
}

copy_overlay() {
  local target_dir="$1"
  while IFS= read -r src; do
    local rel="${src#"$DIY_ROOT/overlay/"}"
    mkdir -p "$(dirname "$target_dir/$rel")"
    cp "$src" "$target_dir/$rel"
  done < <(find "$DIY_ROOT/overlay" -type f | sort)
}

apply_patch_set() {
  local target_dir="$1"
  local patch
  for patch in "$DIY_ROOT"/patches/*.patch; do
    [[ -f "$patch" ]] || continue
    info "应用补丁 $(basename "$patch")"
    git -C "$target_dir" apply --3way "$patch" || die "补丁失败：$(basename "$patch")。说明官方更新影响了 DIY，需要更新 patch。"
  done
}

reset_target_to_official_main() {
  local target_dir="$1"
  info "同步官方 main"
  git -C "$target_dir" fetch "$OFFICIAL_REMOTE_NAME" main --tags
  git -C "$target_dir" reset --hard "$OFFICIAL_REMOTE_NAME/main"
  git -C "$target_dir" clean -fd
}

build_target() {
  local target_dir="$1"
  info "安装依赖"
  pnpm -C "$target_dir" install --no-frozen-lockfile
  info "构建 Control UI"
  pnpm -C "$target_dir" ui:build
  info "构建 OpenClaw"
  pnpm -C "$target_dir" build

  # WeCom 语音依赖 ffmpeg-static；某些 pnpm 环境会默认跳过 build scripts，
  # 这里提前给出明确提示，避免首次发语音时才暴露问题。
  if ! (cd "$target_dir" && node --input-type=module -e 'import ffmpegPath from "ffmpeg-static"; if (!ffmpegPath) process.exit(1)'); then
    warn "ffmpeg-static 当前不可用；WeCom 语音转写可能失败。"
    warn "如果是 pnpm 跳过 build scripts，请在目标仓库执行：pnpm approve-builds"
  fi
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v key="$key" -F= '
      BEGIN { done = 0 }
      $1 == key { print key "=" ENVIRON["DIY_ENV_VALUE"]; done = 1; next }
      { print }
      END { if (!done) print key "=" ENVIRON["DIY_ENV_VALUE"] }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
}

persist_wecom_env() {
  local state_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
  local env_file="$state_dir/.env"
  mkdir -p "$state_dir"

  if [[ -n "${DIY_ENV_FILE:-}" ]]; then
    info "写入企业微信环境文件到 $env_file"
    cp "$DIY_ENV_FILE" "$env_file"
    return
  fi

  local found=0
  while IFS='=' read -r key value; do
    [[ "$key" == WECOM_* ]] || continue
    found=1
    export DIY_ENV_VALUE="$value"
    upsert_env_var "$env_file" "$key" "$value"
  done < <(env | LC_ALL=C sort)

  if [[ "$found" == "1" ]]; then
    info "已把当前 shell 中的 WECOM_* 写入 $env_file"
  else
    warn "当前 shell 未发现 WECOM_*；跳过写入 $env_file"
  fi
}

resolve_state_dir() {
  printf '%s\n' "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
}

resolve_config_path() {
  local state_dir
  state_dir="$(resolve_state_dir)"
  printf '%s\n' "${OPENCLAW_CONFIG_PATH:-$state_dir/openclaw.json}"
}

run_claw() {
  local target_dir="$1"
  shift
  local state_dir config_path
  state_dir="$(resolve_state_dir)"
  config_path="$(resolve_config_path)"
  OPENCLAW_STATE_DIR="$state_dir" \
  OPENCLAW_CONFIG_PATH="$config_path" \
    node "$target_dir/dist/index.js" "$@"
}

configure_target_runtime() {
  local target_dir="$1"

  info "写入本地运行配置"
  run_claw "$target_dir" config set gateway.mode local
  run_claw "$target_dir" config set session.dmScope main
  run_claw "$target_dir" config set tools.profile full
  run_claw "$target_dir" config set tools.exec.applyPatch.enabled true
  run_claw "$target_dir" config set plugins.entries.wecom.enabled true
}

install_or_restart_gateway_service() {
  local target_dir="$1"

  if [[ "${OPENCLAW_DIY_SKIP_SERVICE:-0}" == "1" ]]; then
    warn "OPENCLAW_DIY_SKIP_SERVICE=1，跳过 Gateway service 安装/重启"
    return
  fi

  info "安装或刷新 Gateway service"
  run_claw "$target_dir" gateway install --force --runtime node
}

print_final_status() {
  local target_dir="$1"

  if [[ "${OPENCLAW_DIY_SKIP_SERVICE:-0}" == "1" ]]; then
    info "DIY 已应用完成（跳过 service 模式）"
    info "state dir: $(resolve_state_dir)"
    info "config path: $(resolve_config_path)"
    return
  fi

  info "当前状态"
  run_claw "$target_dir" status --all || true
}
