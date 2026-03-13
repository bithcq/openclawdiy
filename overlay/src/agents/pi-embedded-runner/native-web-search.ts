/**
 * 在 baseUrl 模式下切换为模型原生 web_search，并禁用本地 web_search 工具定义。
 * 只要模型配置了 baseUrl，就将请求 payload 改写为 hosted web_search。
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { normalizeToolName } from "../tool-policy.js";

type NamedTool = { name?: string };

const HOSTED_WEB_SEARCH_TOOL = { type: "web_search" } as const;

function canonicalToolName(name: string): string {
  const normalized = normalizeToolName(name);
  return normalized.startsWith("$") ? normalized.slice(1) : normalized;
}

function isWebSearchName(name: string): boolean {
  return canonicalToolName(name) === "web_search";
}

function isLocalWebSearchTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") {
    return false;
  }
  const name = (tool as { name?: unknown }).name;
  return typeof name === "string" && isWebSearchName(name);
}

function resolveHostedToolType(tool: unknown): string | undefined {
  if (!tool || typeof tool !== "object") {
    return undefined;
  }
  const type = (tool as { type?: unknown }).type;
  if (typeof type !== "string") {
    return undefined;
  }
  const normalized = type.trim().toLowerCase();
  return normalized || undefined;
}

function isHostedWebSearchToolDefinition(tool: unknown): boolean {
  return resolveHostedToolType(tool) === "web_search";
}

function isHostedWebSearchPreviewToolDefinition(tool: unknown): boolean {
  return resolveHostedToolType(tool) === "web_search_preview";
}

function isFunctionWebSearchToolDefinition(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") {
    return false;
  }
  const type = (tool as { type?: unknown }).type;
  if (type !== "function") {
    return false;
  }
  const fn = (tool as { function?: unknown }).function;
  if (!fn || typeof fn !== "object") {
    return false;
  }
  const name = (fn as { name?: unknown }).name;
  return typeof name === "string" && isWebSearchName(name);
}

function normalizeToolChoiceForNativeWebSearch(payload: Record<string, unknown>): void {
  const toolChoice = payload.tool_choice;
  if (!toolChoice || typeof toolChoice !== "object") {
    return;
  }
  const toolChoiceRecord = toolChoice as Record<string, unknown>;
  const type = toolChoiceRecord.type;
  if (typeof type !== "string" || type.trim().toLowerCase() !== "function") {
    return;
  }
  const fn = toolChoiceRecord.function;
  if (!fn || typeof fn !== "object") {
    return;
  }
  const name = (fn as { name?: unknown }).name;
  if (typeof name === "string" && isWebSearchName(name)) {
    payload.tool_choice = "auto";
  }
}

function rewritePayloadWithNativeWebSearch(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const payloadRecord = payload as Record<string, unknown>;
  const rawTools = Array.isArray(payloadRecord.tools) ? payloadRecord.tools : [];
  const nextTools = rawTools.filter(
    (tool) =>
      !isFunctionWebSearchToolDefinition(tool) && !isHostedWebSearchPreviewToolDefinition(tool),
  );
  if (!nextTools.some((tool) => isHostedWebSearchToolDefinition(tool))) {
    nextTools.push({ ...HOSTED_WEB_SEARCH_TOOL });
  }
  payloadRecord.tools = nextTools;
  normalizeToolChoiceForNativeWebSearch(payloadRecord);
}

export function shouldUseNativeWebSearchForBaseUrl(params: {
  model: { baseUrl?: string } | undefined;
}) {
  return Boolean(params.model?.baseUrl?.trim());
}

export function filterLocalWebSearchTools<T extends NamedTool>(tools: T[]): T[] {
  return tools.filter((tool) => !isLocalWebSearchTool(tool));
}

export function wrapStreamFnWithNativeWebSearch(baseFn: StreamFn | undefined): StreamFn {
  const streamFn = baseFn ?? streamSimple;
  return (model, context, options) =>
    streamFn(model, context, {
      ...options,
      onPayload: (payload: unknown, payloadModel: unknown) => {
        rewritePayloadWithNativeWebSearch(payload);
        return options?.onPayload?.(payload, payloadModel as never);
      },
    });
}
