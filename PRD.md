# 功能说明：定义 openclaw-diy 的整体目标、安装边界与交付范围。
# 主要职责：约束官方底座 + DIY 叠加层的安装/更新方式，以及本地运行配置策略。
# 关键依赖：openclaw/openclaw 官方仓库、Debian/Ubuntu 系统依赖、Node.js 22+、pnpm。

# OpenClaw DIY PRD

## 1. 产品目标

- 基于官方 `openclaw/openclaw` 仓库交付可重复安装的 DIY 版本
- 定制层只维护必要的 overlay、patch 和本地运行配置
- 新机器上一条命令完成系统依赖、官方底座和 DIY 叠加

## 2. 目标用户

- 在 Debian/Ubuntu 新机器上从零部署 OpenClaw 的用户
- 已有官方 OpenClaw，需要重新套用 DIY 能力的用户

## 3. 核心范围

- 安装系统依赖：`git`、`curl`、`ffmpeg`、构建工具链等
- 确保 Node.js 22+ 可用
- 确保 `pnpm` 可用于后续依赖安装和构建
- 克隆或更新官方仓库，覆盖 DIY overlay，应用 patch，写入本地配置

## 4. 安装行为约束

- 默认把目标官方仓库视为可重建目录，更新时允许覆盖已有 DIY 产物
- `pnpm` 优先通过 `corepack` 启用
- 当 `corepack` 默认 shim 目录不可写时，脚本必须自动回退到用户目录 `~/.local/bin`
- 回退到用户目录后，安装流程必须保证当前执行链路内能直接使用 `pnpm`
- 公开文档必须明确说明用户后续 shell 可能需要把 `~/.local/bin` 加入 `PATH`

## 5. 非目标

- 不维护官方底座的长期分叉
- 不为非 Debian/Ubuntu 发行版提供专门适配
- 不在目标官方仓库内支持人工长期开发工作流
