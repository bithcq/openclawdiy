# 功能说明：记录官方 openclaw 更新导致 DIY 失败时的排查与修复流程。
# 主要职责：覆盖 plugin-sdk import 路径变更的定位和修复步骤。
# 关键依赖：git、pnpm、openclaw/openclaw 官方仓库。

# DIY 维护指南

## 1. 什么时候需要维护

DIY 采用外部插件模式，官方仓库保持干净，大部分官方更新不影响 DIY。

唯一需要维护的场景：

| 变更类型 | 影响范围 | 发生频率 |
|---------|---------|---------|
| `plugin-sdk` 导出结构调整（函数/类型从入口移除或改名） | `extensions/wecom/` 中的 import 运行时报 `is not defined` | 较低，API 重构才会触发 |

**典型症状：**

- 运行时日志报 `ReferenceError: xxx is not defined`

## 2. Import 路径变更的修复

### 2.1 定位问题

运行时日志会报 `ReferenceError: xxx is not defined`，指向 WeCom 插件文件。

根因：WeCom 源码从 `openclaw/plugin-sdk` 导入的值，实际上不在该入口文件中导出。

### 2.2 排查方法

```bash
cd ~/openclaw

# 确认根入口是否导出了目标符号
grep 'buildChannelConfigSchema' src/plugin-sdk/index.ts

# 如果没有，搜索它在哪个子路径导出
grep -rn 'export.*buildChannelConfigSchema' src/plugin-sdk/
```

### 2.3 修复步骤

1. 找到目标符号的正确子路径（如 `openclaw/plugin-sdk/core`）
2. 修改 `extensions/wecom/src/` 中对应文件的 import
3. 规则：
   - **值导入**（函数、常量）必须从实际导出它的子路径导入
   - **类型导入**（`import type`）可以保留在根入口，因为编译后会被擦除

### 2.4 当前 import 映射

| 符号 | 正确来源 |
|------|---------|
| `buildChannelConfigSchema` | `openclaw/plugin-sdk/core` |
| `DEFAULT_ACCOUNT_ID` | `openclaw/plugin-sdk/core` |
| `setAccountEnabledInConfigSection` | `openclaw/plugin-sdk/core` |
| `waitUntilAbort` | `openclaw/plugin-sdk/channel-lifecycle` |
| `registerPluginHttpRoute` | `openclaw/plugin-sdk/synology-chat` |
| `isRequestBodyLimitError` | `openclaw/plugin-sdk/synology-chat` |
| `readRequestBodyWithLimit` | `openclaw/plugin-sdk/synology-chat` |
| `requestBodyErrorToText` | `openclaw/plugin-sdk/synology-chat` |
| `emptyPluginConfigSchema` | `openclaw/plugin-sdk`（根入口） |
| `type ChannelPlugin` | `openclaw/plugin-sdk`（根入口） |
| `type OpenClawConfig` | `openclaw/plugin-sdk`（根入口） |
| `type PluginRuntime` | `openclaw/plugin-sdk`（根入口） |
| `type OpenClawPluginApi` | `openclaw/plugin-sdk`（根入口） |

如果官方将来新增子路径或调整导出位置，用以下命令重新定位：

```bash
grep -rn 'export.*目标符号' src/plugin-sdk/
```

## 3. 完整修复后的验证

修复 import 后，完整验证流程：

```bash
# 1. 重新运行安装脚本
bash <(curl -fsSL https://raw.githubusercontent.com/bithcq/openclawdiy/main/install-diy.sh)

# 2. 检查 gateway 启动日志
sudo journalctl -u openclaw-gateway -n 50 --no-pager

# 3. 确认 WeCom 插件加载成功（日志中应出现 wecom 相关行，无 ReferenceError）
sudo journalctl -u openclaw-gateway --no-pager | grep -i wecom
```
