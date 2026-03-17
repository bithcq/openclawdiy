# 功能说明：记录官方 openclaw 更新导致 DIY 失败时的排查与修复流程。
# 主要职责：覆盖补丁失配、overlay import 路径变更两类常见问题的定位和修复步骤。
# 关键依赖：git、pnpm、openclaw/openclaw 官方仓库。

# DIY 维护指南

## 1. 什么时候需要维护

DIY 层叠加在官方 `openclaw/openclaw` 之上，以下两种官方变更会导致 DIY 安装失败：

| 变更类型 | 影响范围 | 发生频率 |
|---------|---------|---------|
| 被 patch 的文件发生改动（行号偏移、上下文变更） | `patches/*.patch` 应用失败 | 较高，核心文件改动频繁 |
| `plugin-sdk` 导出结构调整（函数/类型从根入口移除或改名） | `overlay/` 中的 import 运行时报 `is not defined` | 较低，API 重构才会触发 |

**典型症状：**

- 安装脚本输出 `ERROR: 补丁失败：0001-xxx.patch`
- 运行时日志报 `ReferenceError: xxx is not defined`

## 2. 补丁失配的修复

### 2.1 定位问题

安装脚本会明确指出哪个补丁失败。手动验证：

```bash
cd ~/openclaw
git reset --hard origin/main        # 回到干净的官方最新
git apply --check ~/openclawdiy/patches/0001-plugin-route-registry-alignment.patch
```

如果输出 `error: patch failed`，说明该补丁的上下文与当前官方代码不匹配。

### 2.2 修复步骤

核心思路：在干净的官方最新代码上重新手工应用改动，再导出新补丁。

```bash
# 1. 回到干净官方代码
cd ~/openclaw
git reset --hard origin/main

# 2. 查看旧补丁改了哪些文件、改了什么
cat ~/openclawdiy/patches/0001-plugin-route-registry-alignment.patch

# 3. 在官方代码上手工应用同等逻辑的改动
#    （编辑对应文件，保持改动意图不变，适配新的上下文）

# 4. 生成新补丁（只包含被改动的文件）
git diff src/gateway/server-channels.test.ts \
         src/gateway/server-channels.ts \
         src/gateway/server.impl.ts \
  > ~/openclawdiy/patches/0001-plugin-route-registry-alignment.patch

# 5. 验证新补丁
git checkout -- .
git apply --check ~/openclawdiy/patches/0001-plugin-route-registry-alignment.patch
```

### 2.3 验证要点

- `git apply --check` 无输出表示通过
- 如果有多个补丁，必须按编号顺序验证，因为后续补丁可能依赖前序补丁的改动

### 2.4 当前补丁清单

| 补丁 | 改动文件 | 改动意图 |
|------|---------|---------|
| `0001-plugin-route-registry-alignment.patch` | `server-channels.ts`, `server-channels.test.ts`, `server.impl.ts` | 防止插件动态注册 HTTP 路由时 registry 漂移 |

## 3. Overlay import 路径变更的修复

### 3.1 定位问题

运行时日志会报 `ReferenceError: xxx is not defined`，指向 `dist-runtime/extensions/wecom/index.js`。

根因：WeCom 源码从 `openclaw/plugin-sdk` 导入的值，实际上不在该入口文件中导出。

### 3.2 排查方法

```bash
cd ~/openclaw

# 确认根入口是否导出了目标符号
grep 'buildChannelConfigSchema' src/plugin-sdk/index.ts

# 如果没有，搜索它在哪个子路径导出
grep -rn 'export.*buildChannelConfigSchema' src/plugin-sdk/
```

### 3.3 修复步骤

1. 找到目标符号的正确子路径（如 `openclaw/plugin-sdk/core`）
2. 修改 `overlay/extensions/wecom/src/` 中对应文件的 import
3. 规则：
   - **值导入**（函数、常量）必须从实际导出它的子路径导入
   - **类型导入**（`import type`）可以保留在根入口，因为编译后会被擦除

### 3.4 当前 import 映射

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

## 4. 完整修复后的验证

修复补丁或 overlay 后，完整验证流程：

```bash
# 1. 重新运行安装脚本
bash <(curl -fsSL https://raw.githubusercontent.com/bithcq/openclawdiy/main/install-diy.sh)

# 2. 检查 gateway 启动日志
sudo journalctl -u openclaw-gateway -n 50 --no-pager

# 3. 确认 WeCom 插件加载成功（日志中应出现 wecom 相关行，无 ReferenceError）
sudo journalctl -u openclaw-gateway --no-pager | grep -i wecom
```

## 5. 降低维护频率的建议

- **锁定官方版本**：在安装脚本中固定已验证的官方 commit hash，按需升级而非被动跟随
- **推动上游合并**：将 plugin-route-registry 的改动提交为官方 PR，合并后可删除对应 patch
- **监控官方变更**：关注 `src/gateway/server-channels.ts` 的 commit，提前发现冲突
