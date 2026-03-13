# OpenClaw DIY

这个目录是给 `openclaw-diy` 形态准备的最小定制层。

目标：

- 底座始终使用官方 `openclaw/openclaw`
- 只维护自己的定制能力
- 官方更新后，重新跑一次脚本即可重新套用定制

当前 DIY 只保留两类定制：

- `extensions/wecom/**`
- `native web_search` 最小核心补丁

另外，脚本会顺手写入本地运行配置：

- `gateway.mode=local`
- `gateway.bind=lan`
- `session.dmScope=main`
- `tools.profile=full`
- `tools.exec.applyPatch.enabled=true`
- `plugins.entries.wecom.enabled=true`

## 目录说明

- `overlay/`
  - 直接覆盖到官方仓库里的文件
- `patches/`
  - 对官方核心文件的最小补丁
- `scripts/install-diy.sh`
  - 首次安装官方仓库并套用 DIY
- `scripts/update-diy.sh`
  - 更新官方仓库后重新套用 DIY
- `scripts/apply-diy.sh`
  - 只负责把 overlay + patch + 本地配置应用到目标仓库

## 用法

这个目录既可以：

- 作为当前仓库里的 `diy/` 子目录使用
- 也可以单独拆成 `openclaw-diy` 仓库直接使用

## 推荐入口

你现在主要只需要记住两个脚本：

### 1. 新电脑一键安装

适用于：

- 新电脑
- 还没安装 OpenClaw
- 想一条命令完成“官方底座 + DIY”

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bithcq/openclawdiy/main/install-new.sh)
```

### 2. 官方 OpenClaw 已装好，或刚更新完官方后重新套 DIY

适用于：

- 已经有 `~/openclaw`
- 刚跑过官方更新
- 只想重新安装 DIY 层

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/bithcq/openclawdiy/main/install-diy.sh)
```

跑完后，补充 `~/.openclaw/.env` 里的企业微信配置即可。

## 兼容入口

下面这些入口仍然保留，方便兼容旧习惯：

- `bootstrap.sh`
  - 等价于 `install-new.sh`
- `install.sh`
  - 等价于 `install-diy.sh`
- `update.sh`
  - 对已存在的官方仓库重新拉最新后套 DIY
- `install-openclaw-base.sh`
  - 只安装最适合 DIY 的官方 Git 底座

如果是独立仓库手动运行，也可以：

新电脑从零开始：

```bash
bash install-new.sh
```

已装官方版后套 DIY：

```bash
bash install-diy.sh
```

官方更新后重新套 DIY：

```bash
bash update.sh
```

默认目标目录是 `~/openclaw`，也可以自己指定：

```bash
bash install-new.sh /path/to/openclaw
bash install-diy.sh /path/to/openclaw
bash update.sh /path/to/openclaw
```

如果你当前就是在 OpenClaw 主仓里直接运行，则把命令前缀改成 `diy/`：

```bash
bash diy/install-new.sh
bash diy/install-diy.sh
bash diy/update.sh
```

脚本默认把目标官方仓库当作“可重建目录”处理：

- 会先 `fetch + reset --hard` 到官方最新 `main`
- 再清理旧的 DIY 叠加文件
- 最后重新套用 overlay、patch 和本地配置

所以目标目录里不要放手工长期维护的改动。

## 企业微信凭据

脚本会优先把当前 shell 里的所有 `WECOM_*` 环境变量写入状态目录下的 `.env`。

默认状态目录是：

- `~/.openclaw`

也可以覆盖：

```bash
OPENCLAW_STATE_DIR=/path/to/state bash scripts/install-diy.sh
```

如果要显式指定配置文件路径，也支持：

```bash
OPENCLAW_CONFIG_PATH=/path/to/openclaw.json bash scripts/install-diy.sh
```

如果你要覆盖默认的网关绑定方式，也支持：

```bash
OPENCLAW_DIY_GATEWAY_BIND=loopback bash scripts/install-diy.sh
```

也可以显式指定一个 env 文件：

```bash
DIY_ENV_FILE=/path/to/wecom.env bash scripts/install-diy.sh
```

模板见：

- `templates/wecom.env.example`

如果当前 shell 没有 `WECOM_*`，脚本会在 `~/.openclaw/.env` 不存在时自动生成模板文件，方便你直接补充。

## 语音依赖说明

WeCom 语音转写依赖 `ffmpeg-static`。

有些 `pnpm` 环境会默认跳过依赖的 build scripts。脚本已经会给出告警，但如果你首次安装后语音仍不可用，优先在目标官方仓库里执行：

```bash
pnpm approve-builds
pnpm install
```

## 约束

- 目标官方仓库默认被视为“生成产物目录”，不要在里面做人工长期开发。
- 更新脚本会把目标仓库重置到官方最新 `origin/main` 后再重新套用 DIY。
- 如果官方更新导致 patch 无法应用，脚本会直接失败；这时只需要更新 `patches/*` 或 `overlay/*`。
- 当前脚本会额外写入本地运行配置，所以它既负责“套代码”，也负责“把这台机器配置成可运行的 DIY 版本”。
