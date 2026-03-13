/**
 * 文件功能：读取并解析 channels.wecom 配置，统一完成账户与环境变量回退。
 * 主要类/函数：listWecomAccountIds 列举账户；resolveWecomAccount 返回带默认值的可用账户配置。
 * 关键依赖或环境变量：channels.wecom、WECOM_*。
 */

import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk";
import type { ResolvedWecomAccount, WecomAccountRaw, WecomChannelConfig } from "./types.js";

function getChannelConfig(cfg: OpenClawConfig): WecomChannelConfig | undefined {
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const raw = channels["wecom"];
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  return raw as WecomChannelConfig;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return fallback;
}

function toTrimmed(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function parseAllowFrom(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pickDmPolicy(value: unknown): ResolvedWecomAccount["dmPolicy"] {
  const normalized = toTrimmed(value).toLowerCase();
  if (normalized === "allowlist") {
    return "allowlist";
  }
  if (normalized === "disabled") {
    return "disabled";
  }
  return "open";
}

function resolveDefaultAccountId(cfg: OpenClawConfig): string {
  const channelCfg = getChannelConfig(cfg);
  const fromCfg = toTrimmed(channelCfg?.defaultAccount);
  if (fromCfg) {
    return fromCfg;
  }
  return DEFAULT_ACCOUNT_ID;
}

function hasAnyCredential(config?: WecomAccountRaw): boolean {
  if (!config) {
    return false;
  }
  return Boolean(
    toTrimmed(config.corpId) ||
    toTrimmed(config.agentId) ||
    toTrimmed(config.secret) ||
    toTrimmed(config.token),
  );
}

export function listWecomAccountIds(cfg: OpenClawConfig): string[] {
  const channelCfg = getChannelConfig(cfg);
  const ids = new Set<string>();
  const defaultId = resolveDefaultAccountId(cfg);

  if (hasAnyCredential(channelCfg)) {
    ids.add(defaultId);
  }

  const envConfigured =
    toTrimmed(process.env.WECOM_CORP_ID) ||
    toTrimmed(process.env.WECOM_AGENT_ID) ||
    toTrimmed(process.env.WECOM_SECRET);
  if (envConfigured) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  const accounts = channelCfg?.accounts ?? {};
  for (const accountId of Object.keys(accounts)) {
    ids.add(accountId);
  }

  if (ids.size === 0) {
    ids.add(defaultId);
  }
  return Array.from(ids);
}

export function resolveWecomAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedWecomAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const defaultId = resolveDefaultAccountId(cfg);
  const resolvedAccountId = toTrimmed(accountId) || defaultId;
  const accountOverride = (channelCfg.accounts ?? {})[resolvedAccountId] ?? {};

  const merged: WecomAccountRaw = {
    ...channelCfg,
    ...accountOverride,
  };

  const corpId = toTrimmed(merged.corpId) || toTrimmed(process.env.WECOM_CORP_ID);
  const agentId = toTrimmed(merged.agentId) || toTrimmed(process.env.WECOM_AGENT_ID);
  const secret = toTrimmed(merged.secret) || toTrimmed(process.env.WECOM_SECRET);
  const token = toTrimmed(merged.token) || toTrimmed(process.env.WECOM_TOKEN);
  const aesKey = toTrimmed(merged.aesKey) || toTrimmed(process.env.WECOM_AES_KEY);
  const webhookPath =
    toTrimmed(merged.webhookPath) ||
    toTrimmed(process.env.WECOM_CALLBACK_PATH) ||
    "/api/wecom/callback";
  const proxyUrl = toTrimmed(merged.proxyUrl) || toTrimmed(process.env.WECOM_PROXY_URL);
  const messageToUser =
    toTrimmed(merged.messageToUser) || toTrimmed(process.env.WECOM_MESSAGE_TOUSER) || "@all";

  const allowFrom = parseAllowFrom(merged.allowFrom ?? process.env.WECOM_ALLOW_FROM);
  const dmPolicy = pickDmPolicy(merged.dmPolicy ?? process.env.WECOM_DM_POLICY);
  const enabled = toBool(merged.enabled, true);

  // 豆包语音识别配置，优先使用 v3 的 resourceId；旧 cluster 配置仅作兼容回退。
  const doubaoAsrAppId =
    toTrimmed(merged.doubaoAsrAppId) || toTrimmed(process.env.WECOM_DOUBAO_ASR_APP_ID);
  const doubaoAsrToken =
    toTrimmed(merged.doubaoAsrToken) || toTrimmed(process.env.WECOM_DOUBAO_ASR_TOKEN);
  const doubaoAsrCluster =
    toTrimmed(merged.doubaoAsrCluster) ||
    toTrimmed(process.env.WECOM_DOUBAO_ASR_CLUSTER) ||
    "volcengine_streaming_common";
  const doubaoAsrResourceId =
    toTrimmed(merged.doubaoAsrResourceId) ||
    toTrimmed(process.env.WECOM_DOUBAO_ASR_RESOURCE_ID) ||
    (doubaoAsrCluster !== "volcengine_streaming_common" ? doubaoAsrCluster : "");

  return {
    accountId: resolvedAccountId,
    enabled,
    name: toTrimmed(merged.name) || undefined,
    configured: Boolean(corpId && agentId && secret),
    corpId,
    agentId,
    secret,
    token,
    aesKey,
    webhookPath,
    proxyUrl,
    messageToUser,
    dmPolicy,
    allowFrom,
    doubaoAsrAppId,
    doubaoAsrToken,
    doubaoAsrResourceId,
    doubaoAsrCluster,
  };
}
