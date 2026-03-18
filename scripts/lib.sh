#!/usr/bin/env bash
set -euo pipefail

# 功能说明：封装 openclaw-diy 安装/更新流程的共享基础能力。
# 主要函数职责：负责系统依赖、Node/pnpm、仓库准备、外部插件注册与本地运行配置。
# 关键依赖：bash、git、curl、sudo、node、corepack 或 npm。

DIY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_TARGET_DIR="${OPENCLAW_TARGET_DIR:-$HOME/openclaw}"
OFFICIAL_REMOTE_NAME="${OPENCLAW_OFFICIAL_REMOTE_NAME:-origin}"
OFFICIAL_REMOTE_URL="${OPENCLAW_OFFICIAL_REMOTE_URL:-https://github.com/openclaw/openclaw.git}"
REQUIRED_NODE_MAJOR="${OPENCLAW_DIY_NODE_MAJOR:-22}"
USER_BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"

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

ensure_user_bin_on_path() {
  if [[ -d "$USER_BIN_DIR" && ":$PATH:" != *":$USER_BIN_DIR:"* ]]; then
    export PATH="$USER_BIN_DIR:$PATH"
  fi
}

ensure_user_bin_on_path

detect_linux_distro() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    printf '%s\n' "${ID:-unknown}"
    return
  fi
  printf 'unknown\n'
}

ensure_apt_package() {
  local pkg="$1"
  dpkg -s "$pkg" >/dev/null 2>&1 || sudo apt-get install -y "$pkg"
}

ensure_system_prereqs() {
  local distro
  distro="$(detect_linux_distro)"
  case "$distro" in
    ubuntu|debian)
      ;;
    *)
      warn "当前发行版不是 Debian/Ubuntu；脚本按 Debian 系路径继续。"
      ;;
  esac

  if ! command -v sudo >/dev/null 2>&1; then
    die "缺少 sudo；一键安装脚本需要 sudo 安装系统依赖。"
  fi

  local missing=0
  for cmd in git curl node; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing=1
      break
    fi
  done
  if [[ "$missing" == "1" ]] || ! command -v corepack >/dev/null 2>&1; then
    info "安装系统依赖"
    sudo apt-get update
  fi

  ensure_apt_package git
  ensure_apt_package curl
  ensure_apt_package ca-certificates
  ensure_apt_package gnupg
  ensure_apt_package build-essential
  ensure_apt_package python3
  ensure_apt_package ffmpeg
}

ensure_node_runtime() {
  local need_install=0
  if ! command -v node >/dev/null 2>&1; then
    need_install=1
  else
    local major
    major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ -z "$major" || "$major" -lt "$REQUIRED_NODE_MAJOR" ]]; then
      need_install=1
    fi
  fi

  if [[ "$need_install" == "1" ]]; then
    info "安装 Node.js ${REQUIRED_NODE_MAJOR}+"
    curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  fi

  info "当前 Node.js: $(node -v)"
}

ensure_pnpm() {
  ensure_user_bin_on_path

  if command -v pnpm >/dev/null 2>&1; then
    info "当前 pnpm: $(pnpm -v)"
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    local install_dir
    install_dir="$(dirname "$(command -v corepack)")"
    if [[ ! -w "$install_dir" ]]; then
      install_dir="$USER_BIN_DIR"
      mkdir -p "$install_dir"
      ensure_user_bin_on_path
      warn "corepack 默认安装目录不可写，改为用户目录：$install_dir"
      warn "后续 shell 如果找不到 pnpm，请把 $install_dir 加入 PATH。"
    fi

    info "通过 corepack 启用 pnpm"
    corepack enable pnpm --install-directory "$install_dir"
    corepack prepare pnpm@latest --activate
  else
    info "通过 npm 安装 pnpm"
    sudo npm install -g pnpm
  fi

  command -v pnpm >/dev/null 2>&1 || die "pnpm 安装失败"
  info "当前 pnpm: $(pnpm -v)"
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

install_wecom_deps() {
  local wecom_dir="$DIY_ROOT/extensions/wecom"
  [[ -d "$wecom_dir" ]] || die "WeCom 插件目录不存在：$wecom_dir"
  info "安装 WeCom 插件依赖"
  pnpm -C "$wecom_dir" install
}

link_wecom_plugin() {
  local target_dir="$1"
  local wecom_dir="$DIY_ROOT/extensions/wecom"
  info "注册 WeCom 外部插件"
  run_claw "$target_dir" plugins install --link "$wecom_dir"
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
  pnpm -C "$target_dir" install --force
  info "构建 Control UI"
  pnpm -C "$target_dir" ui:build
  info "构建 OpenClaw"
  pnpm -C "$target_dir" build
}

warn_if_wecom_voice_deps_missing() {
  # WeCom 语音转写允许两条路径：
  # 1. ffmpeg-static 二进制存在且可执行
  # 2. 系统 ffmpeg 在 PATH 中可用
  # 只要满足其中一条，就不再报警。
  local wecom_dir="$DIY_ROOT/extensions/wecom"
  if command -v ffmpeg >/dev/null 2>&1; then
    info "检测到系统 ffmpeg：$(command -v ffmpeg)"
    return
  fi

  if (
    cd "$wecom_dir" &&
      node --input-type=module -e 'import fs from "node:fs"; import ffmpegPath from "ffmpeg-static"; process.exit(typeof ffmpegPath === "string" && fs.existsSync(ffmpegPath) ? 0 : 1)'
  ); then
    info "检测到 ffmpeg-static 二进制"
    return
  fi

  warn "未检测到可用的 ffmpeg；WeCom 语音转写会失败。"
  warn "如果是 pnpm 跳过 build scripts，请在 WeCom 插件目录执行：pnpm approve-builds，并允许 ffmpeg-static。"
  warn "或者直接安装系统 ffmpeg（DIY 脚本默认会尝试安装）。"
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
  local template_file="$DIY_ROOT/templates/wecom.env.example"
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
    if [[ ! -f "$env_file" && -f "$template_file" ]]; then
      cp "$template_file" "$env_file"
      warn "未检测到 WECOM_*；已生成模板文件 $env_file，请补充企业微信配置。"
      return
    fi
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

install_cli_wrapper() {
  local target_dir="$1"
  local bin_dir="${OPENCLAW_DIY_BIN_DIR:-$HOME/.local/bin}"
  local wrapper_path="$bin_dir/openclaw"
  local system_bin_dir="${OPENCLAW_DIY_SYSTEM_BIN_DIR:-/usr/local/bin}"
  local system_wrapper_path="$system_bin_dir/openclaw"
  local preferred_node
  preferred_node="$(command -v node)"

  if [[ "${OPENCLAW_DIY_SKIP_PATH:-0}" == "1" ]]; then
    warn "OPENCLAW_DIY_SKIP_PATH=1，跳过 PATH 入口安装"
    return
  fi

  mkdir -p "$bin_dir"
  cat >"$wrapper_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_ROOT="${target_dir}"
OPENCLAW_CLI="\${OPENCLAW_ROOT}/dist/index.js"
PREFERRED_NODE="${preferred_node}"

if [ -x "\${PREFERRED_NODE}" ]; then
  exec "\${PREFERRED_NODE}" "\${OPENCLAW_CLI}" "\$@"
fi

for candidate in \
  /usr/bin/node \
  /usr/local/bin/node \
  "\$HOME/.nvm/versions/node"/*/bin/node \
  "\$HOME/.volta/bin/node"
do
  if [ -x "\$candidate" ]; then
    exec "\$candidate" "\${OPENCLAW_CLI}" "\$@"
  fi
done

if command -v node >/dev/null 2>&1; then
  exec "\$(command -v node)" "\${OPENCLAW_CLI}" "\$@"
fi

echo "openclaw: node not found" >&2
exit 127
EOF
  chmod +x "$wrapper_path"
  info "已安装 CLI 入口：$wrapper_path"

  if [[ "$system_wrapper_path" != "$wrapper_path" ]]; then
    if [[ -w "$system_bin_dir" ]]; then
      install -m 755 "$wrapper_path" "$system_wrapper_path"
      info "已安装系统 CLI 入口：$system_wrapper_path"
    elif command -v sudo >/dev/null 2>&1; then
      sudo install -m 755 "$wrapper_path" "$system_wrapper_path"
      info "已安装系统 CLI 入口：$system_wrapper_path"
    else
      warn "无法写入 $system_wrapper_path；当前 shell 可能仍需手动把 $bin_dir 加入 PATH。"
    fi
  fi
}

configure_target_runtime() {
  local target_dir="$1"
  local gateway_bind="${OPENCLAW_DIY_GATEWAY_BIND:-lan}"

  info "写入本地运行配置"
  run_claw "$target_dir" config set gateway.mode local
  run_claw "$target_dir" config set gateway.bind "$gateway_bind"
  run_claw "$target_dir" config set session.dmScope main
  run_claw "$target_dir" config set tools.profile full
  run_claw "$target_dir" config set tools.exec.applyPatch.enabled true
  run_claw "$target_dir" config set channels.wecom.dmPolicy open
  run_claw "$target_dir" config set channels.wecom.allowFrom '["*"]' --strict-json
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
