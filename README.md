# OpenClaw DIY

基于官方 `openclaw/openclaw` 的最小定制层。

- 官方仓库保持干净，可自由跟进更新
- WeCom 作为外部插件独立维护，通过 `plugins install --link` 注册
- 官方更新后重新跑一次脚本即可

文档导航：

- `PRD.md` — 项目目标、安装边界和关键约束
- `MAINTENANCE.md` — 官方更新导致 DIY 失败时的排查与修复流程
- `scripts/SPEC.md` — 安装脚本入口、共享库行为和 pnpm 安装约定

## 架构

```
openclawdiy/              ← DIY 仓库（本仓库）
├── extensions/wecom/     ← WeCom 外部插件（独立依赖、独立维护）
├── scripts/              ← 安装/更新脚本
└── templates/            ← 环境变量模板

~/openclaw/               ← 官方仓库（保持干净，可自由 git pull）

~/.openclaw/              ← 运行状态目录（配置、插件注册、.env）
```

安装流程：
1. 重置官方仓库到最新 `origin/main`
2. 构建官方代码（`pnpm install` + `pnpm build`）
3. 在 WeCom 插件目录执行 `pnpm install` 安装独立依赖
4. 通过 `plugins install --link` 将 WeCom 注册为外部插件
5. 写入本地运行配置到 `~/.openclaw/openclaw.json`

插件注册和运行配置存储在 `~/.openclaw/` 下，不在官方仓库内。官方更新后只需重新构建官方代码，无需重新注册插件。

## 用法

三个入口脚本，覆盖所有场景：

### 新电脑一键安装

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bithcq/openclawdiy/main/install-new.sh)
```

从零开始：安装系统依赖、Node.js、pnpm、克隆官方仓库、构建、注册 WeCom 插件、写入配置。

### 已有官方仓库，首次套用 DIY

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bithcq/openclawdiy/main/install-diy.sh)
```

### 官方更新后重新套用 DIY

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bithcq/openclawdiy/main/update.sh)
```

跑完后，补充 `~/.openclaw/.env` 里的企业微信配置即可。

默认目标目录是 `~/openclaw`，也可以自己指定：

```bash
bash install-new.sh /path/to/openclaw
bash install-diy.sh /path/to/openclaw
bash update.sh /path/to/openclaw
```

### 说明

- 脚本默认把目标官方仓库当作"可重建目录"，更新时会 `reset --hard` 到官方最新
- 如果当前机器的 Node.js 是系统级安装，脚本会在 `corepack` 默认目录不可写时自动把 `pnpm` shim 安装到 `~/.local/bin`
- CLI 会同时安装到 `~/.local/bin/openclaw` 和 `/usr/local/bin/openclaw`
- 后续 shell 如果找不到 `pnpm`，请把 `~/.local/bin` 加入 `PATH`

## 企业微信凭据

脚本会优先把当前 shell 里的所有 `WECOM_*` 环境变量写入 `~/.openclaw/.env`。

也支持显式指定：

```bash
# 指定 env 文件
DIY_ENV_FILE=/path/to/wecom.env bash install-diy.sh

# 指定状态目录
OPENCLAW_STATE_DIR=/path/to/state bash install-diy.sh

# 指定配置文件路径
OPENCLAW_CONFIG_PATH=/path/to/openclaw.json bash install-diy.sh

# 覆盖网关绑定方式
OPENCLAW_DIY_GATEWAY_BIND=loopback bash install-diy.sh
```

模板见 `templates/wecom.env.example`。如果当前 shell 没有 `WECOM_*`，脚本会自动生成模板文件。

## 语音依赖

WeCom 语音转写支持两条路径（优先 `ffmpeg-static`，回退系统 `ffmpeg`）。

DIY 安装脚本默认会安装系统 `ffmpeg`。如果语音仍不可用：

```bash
cd ~/openclawdiy/extensions/wecom
pnpm approve-builds
pnpm install
```

## 本地运行配置

脚本会写入以下配置：

- `gateway.mode=local`
- `gateway.bind=lan`
- `session.dmScope=main`
- `tools.profile=full`
- `tools.exec.applyPatch.enabled=true`
- `channels.wecom.dmPolicy=open`
- `channels.wecom.allowFrom=["*"]`
