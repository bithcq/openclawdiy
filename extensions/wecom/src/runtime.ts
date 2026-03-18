/**
 * 文件功能：保存 wecom 插件运行时对象，供通道启动与回调处理复用。
 * 主要类/函数：setWecomRuntime 负责注入运行时；getWecomRuntime 负责读取运行时。
 * 关键依赖或环境变量：OpenClaw PluginRuntime。
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setWecomRuntime(nextRuntime: PluginRuntime): void {
  runtime = nextRuntime;
}

export function getWecomRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WeCom runtime not initialized - plugin not registered");
  }
  return runtime;
}
