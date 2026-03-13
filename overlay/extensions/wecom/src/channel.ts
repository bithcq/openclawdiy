/**
 * 文件功能：定义 WeCom 通道插件（配置、出站、回调网关启动）。
 * 主要类/函数：wecomPlugin 负责向 OpenClaw 暴露企业微信能力。
 * 关键依赖或环境变量：channels.wecom、WECOM_*。
 */

import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  registerPluginHttpRoute,
  setAccountEnabledInConfigSection,
  waitUntilAbort,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { z } from "zod";
import { listWecomAccountIds, resolveWecomAccount } from "./accounts.js";
import { sendImageMessage, sendTextMessage, uploadMediaFromUrl } from "./client.js";
import { sanitizeWecomReplyText, splitWecomTextByChars } from "./reply-sanitize.js";
import type { ResolvedWecomAccount } from "./types.js";
import { createWecomWebhookHandler } from "./webhook-handler.js";

const CHANNEL_ID = "wecom";
const DEFAULT_WEBHOOK_PATH = "/api/wecom/callback";
const WECOM_TEXT_MAX_CHARS = 500;
const WECOM_TEXT_CHUNK_DELAY_MS = 500;

const WecomAccountSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    corpId: z.string().optional(),
    agentId: z.string().optional(),
    secret: z.string().optional(),
    token: z.string().optional(),
    aesKey: z.string().optional(),
    webhookPath: z.string().optional(),
    proxyUrl: z.string().optional(),
    messageToUser: z.string().optional(),
    dmPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    allowFrom: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();

const WecomConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultAccount: z.string().optional(),
    corpId: z.string().optional(),
    agentId: z.string().optional(),
    secret: z.string().optional(),
    token: z.string().optional(),
    aesKey: z.string().optional(),
    webhookPath: z.string().optional(),
    proxyUrl: z.string().optional(),
    messageToUser: z.string().optional(),
    dmPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    allowFrom: z.union([z.string(), z.array(z.string())]).optional(),
    accounts: z.record(z.string(), WecomAccountSchema).optional(),
  })
  .passthrough();

function waitUntilAbortWithCleanup(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      onAbort();
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        onAbort();
        resolve();
      },
      { once: true },
    );
  });
}

function normalizeTarget(rawTarget: string): string | undefined {
  const trimmed = rawTarget.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^wecom:(user:)?/i, "")
    .replace(/^user:/i, "")
    .trim();
}

export const wecomPlugin: ChannelPlugin<ResolvedWecomAccount> = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "WeCom",
    selectionLabel: "WeCom (企业微信)",
    detailLabel: "WeCom Bot",
    docsPath: "/channels/wecom",
    docsLabel: "wecom",
    blurb: "Enterprise WeChat callback + messaging channel.",
    order: 95,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    threads: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    effects: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.wecom"] },
  configSchema: buildChannelConfigSchema(WecomConfigSchema),
  config: {
    listAccountIds: (cfg) => listWecomAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWecomAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveWecomAccount(cfg, accountId).allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim()).filter((entry) => Boolean(entry)),
  },
  pairing: {
    idLabel: "wecomUserId",
    normalizeAllowEntry: (entry) => normalizeTarget(entry) ?? entry.trim(),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveWecomAccount(cfg, DEFAULT_ACCOUNT_ID);
      await sendTextMessage({
        account,
        to: normalizeTarget(id),
        content: "OpenClaw: your access has been approved.",
      });
    },
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const channelMap = (cfg.channels ?? {}) as Record<string, unknown>;
      const wecomChannel = channelMap["wecom"] as
        | { accounts?: Record<string, unknown> }
        | undefined;
      const hasAccount = Boolean(wecomChannel?.accounts?.[resolvedAccountId]);
      const allowFromPath = hasAccount
        ? `channels.wecom.accounts.${resolvedAccountId}.`
        : "channels.wecom.";
      return {
        policy: account.dmPolicy,
        allowFrom: account.allowFrom,
        policyPath: `${allowFromPath}dmPolicy`,
        allowFromPath,
        approveHint: "openclaw pairing approve wecom <code>",
        normalizeEntry: (raw) => normalizeTarget(raw) ?? raw,
      };
    },
  },
  messaging: {
    normalizeTarget: (target) => normalizeTarget(target),
    targetResolver: {
      looksLikeId: (target) => Boolean(normalizeTarget(target)),
      hint: "<wecomUserId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveWecomAccount(cfg, accountId ?? undefined);
      const q = query?.trim().toLowerCase() ?? "";
      return account.allowFrom
        .map((id) => id.trim())
        .filter(Boolean)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async () => [],
  },
  outbound: {
    deliveryMode: "gateway",
    // 让 WeCom 自己负责文本拆分和节流，避免上层先拆段后绕过发送间隔。
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveWecomAccount(cfg, accountId);
      const target = normalizeTarget(to) ?? to;
      const cleanedText = sanitizeWecomReplyText(text, false);
      if (!cleanedText) {
        return {
          channel: CHANNEL_ID,
          messageId: `wecom-${Date.now()}`,
          chatId: target,
        };
      }
      const chunks = splitWecomTextByChars(cleanedText, WECOM_TEXT_MAX_CHARS);
      for (const [index, chunk] of chunks.entries()) {
        await sendTextMessage({
          account,
          to: target,
          content: chunk,
        });
        if (chunks.length > 1 && index < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, WECOM_TEXT_CHUNK_DELAY_MS));
        }
      }
      return {
        channel: CHANNEL_ID,
        messageId: `wecom-${Date.now()}`,
        chatId: target,
      };
    },
    sendMedia: async ({ cfg, to, mediaUrl, accountId }) => {
      if (!mediaUrl) {
        throw new Error("wecom sendMedia requires mediaUrl");
      }
      const account = resolveWecomAccount(cfg, accountId);
      const target = normalizeTarget(to) ?? to;
      // 目前只支持发送图片，统一按 image 类型上传。
      const uploaded = await uploadMediaFromUrl({
        account,
        mediaType: "image",
        mediaUrl,
      });
      await sendImageMessage({
        account,
        to: target,
        mediaId: uploaded.mediaId,
      });
      return {
        channel: CHANNEL_ID,
        messageId: `wecom-${Date.now()}`,
        chatId: target,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { cfg, accountId, abortSignal, log, channelRuntime } = ctx;
      const account = resolveWecomAccount(cfg, accountId);

      if (!account.enabled) {
        log?.info?.(`wecom: account ${account.accountId} is disabled`);
        return waitUntilAbort(abortSignal);
      }

      if (!account.configured) {
        log?.warn?.(
          `wecom: account ${account.accountId} is not configured (missing corpId/agentId/secret)`,
        );
        return waitUntilAbort(abortSignal);
      }

      const webhookPath = account.webhookPath.trim() || DEFAULT_WEBHOOK_PATH;
      if (!channelRuntime) {
        log?.error?.("wecom: channelRuntime unavailable, cannot process inbound messages");
        return waitUntilAbort(abortSignal);
      }
      const handler = createWecomWebhookHandler({
        accountId: account.accountId,
        cfg,
        core: channelRuntime,
        log,
      });
      const unregister = registerPluginHttpRoute({
        path: webhookPath,
        auth: "plugin",
        replaceExisting: true,
        pluginId: CHANNEL_ID,
        accountId: account.accountId,
        log: (message) => log?.info?.(message),
        handler,
      });
      log?.info?.(`wecom: webhook route registered at ${webhookPath}`);

      return waitUntilAbortWithCleanup(abortSignal, () => {
        unregister();
        log?.info?.(`wecom: webhook route unregistered at ${webhookPath}`);
      });
    },
    stopAccount: async (ctx) => {
      ctx.log?.info?.(`wecom: account ${ctx.accountId} stopped`);
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "### WeCom 回消息规范",
      "- 你当前通过企业微信对话，优先使用简洁、可执行的中文回复。",
      "- 附件消息可能包含图片，请先读内容再回答。",
      "- 默认不要输出来源链接、URL 或参考资料列表，直接给结论和步骤。",
      "- 只有当用户明确要求“给链接/来源/原文地址”时，才提供链接。",
    ],
  },
};
