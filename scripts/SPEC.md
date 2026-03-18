# 功能说明：定义 scripts 模块对外脚本入口、共享安装逻辑与行为约定。
# 主要职责：约束安装/更新脚本的调用关系，以及依赖安装的边界条件。
# 关键依赖：bash、sudo、git、curl、node、corepack、npm、pnpm。

# Scripts SPEC

## 1. 模块入口

- `bootstrap.sh`
  - 新机器入口，编排脚本
  - 顺序调用 `install-openclaw-base.sh`（安装官方底座）和 `install-diy.sh`（套用 DIY）
- `install-openclaw-base.sh`
  - 只负责准备官方 OpenClaw Git 底座：系统依赖、Node.js、pnpm、克隆仓库、构建、安装 CLI
- `install-diy.sh`
  - 在已有官方仓库上套用 DIY：重置到官方最新、构建、注册 WeCom 外部插件、写入配置
  - 依赖检查由 `apply-diy.sh` 负责，本脚本只检查 git
- `update-diy.sh`
  - 功能与 `install-diy.sh` 相同，语义上用于"官方更新后重新套用"
  - 额外校验目标目录必须已存在
- `apply-diy.sh`
  - 核心执行脚本，负责完整流程：重置官方仓库、构建、安装 WeCom 依赖、注册外部插件、写入配置

## 2. 根目录入口脚本

根目录的 `install-new.sh`、`install-diy.sh`、`update.sh` 是薄包装层：
- 克隆或更新 DIY 仓库自身
- `exec` 到 `scripts/` 下的对应脚本

## 3. 共享库约定

- `lib.sh` 负责系统依赖、Node.js、pnpm、仓库检查、外部插件注册和配置写入
- `lib.sh` 在入口加载时会自动把 `${XDG_BIN_HOME:-$HOME/.local/bin}` 补到 `PATH`，保证多段脚本链路能复用用户目录下的 `pnpm`
- 共享函数对外只保证被 scripts 目录下的入口脚本调用，不承诺稳定的外部 API

## 4. 核心流程

`apply-diy.sh` 的执行顺序：

1. `reset_target_to_official_main` — 拉取并重置到官方最新
2. `persist_wecom_env` — 写入企业微信环境变量
3. `build_target` — 构建官方代码（`pnpm install` + `pnpm build`）
4. `install_wecom_deps` — 在 WeCom 插件目录执行 `pnpm install`
5. `link_wecom_plugin` — 调用 `plugins install --link` 注册外部插件
6. `configure_target_runtime` — 写入本地运行配置

## 5. pnpm 安装行为

- 若系统已存在 `pnpm`，直接复用
- 若存在 `corepack`，默认在 `corepack` 同目录启用 `pnpm` shim
- 若默认 shim 目录不可写，必须回退到 `${XDG_BIN_HOME:-$HOME/.local/bin}`
- 回退时必须在当前脚本进程内补 `PATH`，保证后续 `pnpm install`、`pnpm build` 可直接执行
- 若不存在 `corepack`，回退到 `sudo npm install -g pnpm`

## 6. CLI 安装行为

- `openclaw` CLI 包装脚本默认安装到 `${OPENCLAW_DIY_BIN_DIR:-$HOME/.local/bin}`
- 同时必须额外安装到 `${OPENCLAW_DIY_SYSTEM_BIN_DIR:-/usr/local/bin}`，优先保证常见 shell 默认可发现
- 若系统目录不可直接写入且存在 `sudo`，脚本必须使用 `sudo install`
- 若系统目录不可写且无 `sudo`，只告警，不阻断整体安装

## 7. 错误处理

- 缺少关键命令时立即退出
- 目标仓库远端不是官方 `openclaw/openclaw` 时立即退出
- 目标仓库存在本地改动时只告警，不阻断后续重建流程
- WeCom 插件目录不存在时立即退出
