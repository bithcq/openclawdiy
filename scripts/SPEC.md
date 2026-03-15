# 功能说明：定义 scripts 模块对外脚本入口、共享安装逻辑与行为约定。
# 主要职责：约束 bootstrap/install/update 的调用关系，以及依赖安装的边界条件。
# 关键依赖：bash、sudo、git、curl、node、corepack、npm、pnpm。

# Scripts SPEC

## 1. 模块入口

- `bootstrap.sh`
  - 新机器入口
  - 先安装官方底座，再套用 DIY
- `install-openclaw-base.sh`
  - 只负责准备官方 OpenClaw Git 底座和依赖
- `install-diy.sh`
  - 只负责叠加 overlay、patch 与本地运行配置
- `update-diy.sh`
  - 在已有官方仓库上拉取官方最新后重新套用 DIY
- `apply-diy.sh`
  - 仅执行 overlay、patch 和配置写入，不负责拉取官方代码

## 2. 共享库约定

- `lib.sh` 负责系统依赖、Node.js、pnpm、仓库检查、overlay/patch 应用和配置写入
- `lib.sh` 在入口加载时会自动把 `${XDG_BIN_HOME:-$HOME/.local/bin}` 补到 `PATH`，保证多段脚本链路能复用用户目录下的 `pnpm`
- 共享函数对外只保证被 scripts 目录下的入口脚本调用，不承诺稳定的外部 API

## 3. pnpm 安装行为

- 若系统已存在 `pnpm`，直接复用
- 若存在 `corepack`，默认在 `corepack` 同目录启用 `pnpm` shim
- 若默认 shim 目录不可写，必须回退到 `${XDG_BIN_HOME:-$HOME/.local/bin}`
- 回退时必须在当前脚本进程内补 `PATH`，保证后续 `pnpm install`、`pnpm build` 可直接执行
- 若不存在 `corepack`，回退到 `sudo npm install -g pnpm`

## 4. CLI 安装行为

- `openclaw` CLI 包装脚本默认安装到 `${OPENCLAW_DIY_BIN_DIR:-$HOME/.local/bin}`
- 同时必须额外安装到 `${OPENCLAW_DIY_SYSTEM_BIN_DIR:-/usr/local/bin}`，优先保证常见 shell 默认可发现
- 若系统目录不可直接写入且存在 `sudo`，脚本必须使用 `sudo install`
- 若系统目录不可写且无 `sudo`，只告警，不阻断整体安装

## 5. 错误处理

- 缺少关键命令或补丁应用失败时立即退出
- 目标仓库远端不是官方 `openclaw/openclaw` 时立即退出
- 目标仓库存在本地改动时只告警，不阻断后续重建流程
