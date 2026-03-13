/**
 * 文件功能：处理企业微信回调（GET 验证 + POST 消息），并把消息交给 OpenClaw 对话链路。
 * 主要类/函数：createWecomWebhookHandler 创建回调处理器；dispatchInboundEvent 负责后台消息处理。
 * 关键依赖或环境变量：WECOM_TOKEN、WECOM_AES_KEY、WECOM_CORP_ID。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
  type OpenClawConfig,
  type PluginRuntime,
} from "openclaw/plugin-sdk";
import { resolveWecomAccount } from "./accounts.js";
import { downloadMediaById, downloadMediaFromUrl, sendTextMessage } from "./client.js";
import {
  sanitizeWecomReplyText,
  shouldKeepLinksByUserIntent,
  splitWecomTextByChars,
} from "./reply-sanitize.js";
import type { ResolvedWecomAccount, WecomDownloadedMedia, WecomInboundEvent } from "./types.js";
import { transcribeVoiceBuffer } from "./voice-asr.js";
import { decryptWecomPayload, verifyWecomSignature } from "./wecom-crypto.js";

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const PENDING_MEDIA_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_MEDIA_PER_SESSION = 8;
const WECOM_TEXT_MAX_CHARS = 500;
const WECOM_TEXT_CHUNK_DELAY_MS = 500;
const inboundDedupeCache = new Map<string, number>();
const pendingMediaCache = new Map<
  string,
  {
    expireAt: number;
    media: Array<{ mediaPath: string; mediaType?: string }>;
  }
>();
type WecomCoreRuntime = PluginRuntime["channel"];

function resolveWecomInboundRoute(params: {
  cfg: OpenClawConfig;
  core: WecomCoreRuntime;
  account: ResolvedWecomAccount;
  fromUser: string;
}) {
  return params.core.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "wecom",
    accountId: params.account.accountId,
    peer: {
      kind: "direct",
      id: params.fromUser,
    },
  });
}

function cleanupDedupeCache(now = Date.now()): void {
  for (const [key, expireAt] of inboundDedupeCache.entries()) {
    if (expireAt <= now) {
      inboundDedupeCache.delete(key);
    }
  }
}

function markDedupeAndCheckExists(key: string): boolean {
  const now = Date.now();
  cleanupDedupeCache(now);
  if (inboundDedupeCache.has(key)) {
    return true;
  }
  inboundDedupeCache.set(key, now + DEDUPE_TTL_MS);
  return false;
}

function cleanupPendingMediaCache(now = Date.now()): void {
  for (const [key, bucket] of pendingMediaCache.entries()) {
    if (bucket.expireAt <= now) {
      pendingMediaCache.delete(key);
    }
  }
}

function resolvePendingMediaKey(account: ResolvedWecomAccount, fromUser: string): string {
  return `${account.accountId}:${fromUser}`;
}

function addPendingMedia(params: {
  account: ResolvedWecomAccount;
  fromUser: string;
  mediaPath: string;
  mediaType?: string;
}): { total: number; imageCount: number } {
  const { account, fromUser, mediaPath, mediaType } = params;
  const now = Date.now();
  cleanupPendingMediaCache(now);
  const key = resolvePendingMediaKey(account, fromUser);
  const existed = pendingMediaCache.get(key);
  const media = existed ? [...existed.media] : [];
  media.push({ mediaPath, mediaType });
  // 限制会话缓存数量，避免连续发送附件导致内存堆积。
  if (media.length > MAX_PENDING_MEDIA_PER_SESSION) {
    media.splice(0, media.length - MAX_PENDING_MEDIA_PER_SESSION);
  }
  pendingMediaCache.set(key, {
    media,
    expireAt: now + PENDING_MEDIA_TTL_MS,
  });
  return { total: media.length, imageCount: media.length };
}

function popPendingMedia(
  account: ResolvedWecomAccount,
  fromUser: string,
): Array<{ mediaPath: string; mediaType?: string }> {
  const now = Date.now();
  cleanupPendingMediaCache(now);
  const key = resolvePendingMediaKey(account, fromUser);
  const bucket = pendingMediaCache.get(key);
  if (!bucket) {
    return [];
  }
  pendingMediaCache.delete(key);
  return bucket.media;
}

async function sendWecomTextInChunks(params: {
  account: ResolvedWecomAccount;
  to: string;
  content: string;
}): Promise<void> {
  const { account, to, content } = params;
  // 企业微信单条消息限制为 500 字，超出后按顺序拆分发送。
  const chunks = splitWecomTextByChars(content, WECOM_TEXT_MAX_CHARS);
  for (const [index, chunk] of chunks.entries()) {
    await sendTextMessage({
      account,
      to,
      content: chunk,
    });
    if (chunks.length > 1 && index < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, WECOM_TEXT_CHUNK_DELAY_MS));
    }
  }
}

function readQuery(req: IncomingMessage): URLSearchParams {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  return requestUrl.searchParams;
}

function readXmlTag(xml: string, tagName: string): string | undefined {
  const cdataPattern = new RegExp(
    `<${tagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`,
    "i",
  );
  const cdataMatch = xml.match(cdataPattern);
  if (cdataMatch?.[1] !== undefined) {
    return cdataMatch[1].trim();
  }

  const plainPattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const plainMatch = xml.match(plainPattern);
  if (plainMatch?.[1] !== undefined) {
    return plainMatch[1].trim();
  }
  return undefined;
}

function respondText(res: ServerResponse, statusCode: number, text: string): true {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
  return true;
}

async function readRequestBody(
  req: IncomingMessage,
): Promise<{ ok: true; body: string } | { ok: false; statusCode: number; error: string }> {
  try {
    const body = await readRequestBodyWithLimit(req, {
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 30_000,
    });
    return { ok: true, body };
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      return {
        ok: false,
        statusCode: error.statusCode,
        error: requestBodyErrorToText(error.code),
      };
    }
    return {
      ok: false,
      statusCode: 400,
      error: "Invalid request body",
    };
  }
}

function verifySignatureOrReject(params: {
  account: ResolvedWecomAccount;
  msgSignature: string;
  timestamp: string;
  nonce: string;
  payload: string;
}): string | null {
  const { account, msgSignature, timestamp, nonce, payload } = params;
  const token = account.token.trim();
  if (!token) {
    return "WECOM_TOKEN is empty";
  }
  const valid = verifyWecomSignature({
    token,
    timestamp,
    nonce,
    payload,
    msgSignature,
  });
  if (!valid) {
    return "Invalid callback signature";
  }
  return null;
}

function parseInboundEvent(xmlBody: string): WecomInboundEvent | null {
  const msgType = (readXmlTag(xmlBody, "MsgType") ?? "").toLowerCase();
  const fromUser = readXmlTag(xmlBody, "FromUserName") ?? "";
  const toUser = readXmlTag(xmlBody, "ToUserName") ?? "";
  const msgId = readXmlTag(xmlBody, "MsgId");
  const createTime = readXmlTag(xmlBody, "CreateTime");

  if (!fromUser || !toUser || !msgType) {
    return null;
  }

  if (msgType === "text") {
    return {
      msgType: "text",
      fromUser,
      toUser,
      msgId,
      createTime,
      content: readXmlTag(xmlBody, "Content") ?? "",
    };
  }

  if (msgType === "image") {
    return {
      msgType: "image",
      fromUser,
      toUser,
      msgId,
      createTime,
      mediaId: readXmlTag(xmlBody, "MediaId"),
      picUrl: readXmlTag(xmlBody, "PicUrl"),
    };
  }

  // 语音消息：MediaId 和 Format 均嵌套在 <Voice> 标签内，readXmlTag 全文匹配可直接读取。
  if (msgType === "voice") {
    return {
      msgType: "voice",
      fromUser,
      toUser,
      msgId,
      createTime,
      mediaId: readXmlTag(xmlBody, "MediaId"),
      format: readXmlTag(xmlBody, "Format"),
    };
  }

  return null;
}

function normalizeInboundBody(event: WecomInboundEvent): string {
  if (event.msgType === "text") {
    return (event.content ?? "").trim();
  }
  if (event.msgType === "image") {
    return "用户发送了一张图片，请先理解图片内容后再回复。";
  }
  return "";
}

function resolveDedupeKey(event: WecomInboundEvent): string {
  const suffix = event.mediaId ?? event.content ?? "";
  return event.msgId ?? `${event.fromUser}:${event.createTime ?? "0"}:${event.msgType}:${suffix}`;
}

function allowSenderForAccount(
  account: ResolvedWecomAccount,
  fromUser: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (account.dmPolicy === "disabled") {
    return { allowed: false, reason: "dmPolicy=disabled" };
  }
  if (account.dmPolicy === "open") {
    return { allowed: true };
  }
  if (account.allowFrom.length === 0) {
    return { allowed: false, reason: "allowlist is empty" };
  }
  const allowed = account.allowFrom.includes(fromUser);
  if (!allowed) {
    return { allowed: false, reason: "sender not in allowFrom" };
  }
  return { allowed: true };
}

async function buildInboundContext(params: {
  account: ResolvedWecomAccount;
  event: WecomInboundEvent;
  core: WecomCoreRuntime;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}): Promise<{
  body: string;
  mediaPath?: string;
  mediaType?: string;
  mediaPaths?: string[];
  mediaTypes?: string[];
  mediaUrls?: string[];
  errorReason?: string;
}> {
  const { account, event, core, log } = params;
  const body = normalizeInboundBody(event);

  // 图片消息：先下载企业微信素材，再交给 OpenClaw 的媒体理解链路。
  if (event.msgType === "image") {
    try {
      let downloaded: WecomDownloadedMedia;
      if (event.mediaId?.trim()) {
        downloaded = await downloadMediaById({
          account,
          mediaId: event.mediaId,
        });
      } else if (event.msgType === "image" && event.picUrl?.trim()) {
        // 兜底：个别场景只有 PicUrl 没有 MediaId，仍然尝试下载并进入多模态链路。
        downloaded = await downloadMediaFromUrl({
          account,
          mediaUrl: event.picUrl,
          fileName: `${event.msgId ?? event.createTime ?? Date.now().toString()}.jpg`,
        });
      } else {
        throw new Error("missing mediaId (and picUrl fallback unavailable)");
      }

      const saved = await core.media.saveMediaBuffer(
        downloaded.contentBytes,
        downloaded.contentType,
        "inbound",
        20 * 1024 * 1024,
        downloaded.fileName,
      );
      // 优先使用保存阶段探测出的类型，避免企业微信返回 octet-stream 导致图片识别失败。
      const resolvedMediaTypeRaw = saved.contentType ?? downloaded.contentType;
      const resolvedMediaType =
        !resolvedMediaTypeRaw || !resolvedMediaTypeRaw.toLowerCase().startsWith("image/")
          ? "image/jpeg"
          : resolvedMediaTypeRaw;
      log?.info?.(
        `wecom: inbound media prepared, msgType=${event.msgType}, mediaType=${resolvedMediaType ?? "unknown"}, path=${saved.path}`,
      );

      const mediaBody = "<media:image> 用户发送了一张图片，请先分析图片内容再回复。";
      return {
        body: mediaBody,
        mediaPath: saved.path,
        mediaType: resolvedMediaType,
        mediaPaths: [saved.path],
        mediaTypes: resolvedMediaType ? [resolvedMediaType] : undefined,
        mediaUrls: [saved.path],
      };
    } catch (error) {
      const reason = String(error);
      log?.warn?.(`wecom: media download failed: ${reason}`);
      return {
        body: `${body}\n\n（附件读取失败，已回退为文字处理）`,
        errorReason: reason,
      };
    }
  }

  return { body };
}

function resolveInboundMediaFailureText(): string {
  return "图片接收失败，请重发一张图片。";
}

async function dispatchInboundEvent(params: {
  cfg: OpenClawConfig;
  account: ResolvedWecomAccount;
  event: WecomInboundEvent;
  core: WecomCoreRuntime;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}): Promise<void> {
  const { cfg, account, event, core, log } = params;
  const route = resolveWecomInboundRoute({
    cfg,
    core,
    account,
    fromUser: event.fromUser,
  });
  const authorization = allowSenderForAccount(account, event.fromUser);
  if (!authorization.allowed) {
    log?.warn?.(`wecom: sender blocked (${event.fromUser}), reason=${authorization.reason}`);
    return;
  }

  // 语音消息：下载后通过豆包 ASR 转文字，再以文本消息身份 dispatch 到 agent。
  if (event.msgType === "voice") {
    const asrConfigured = Boolean(
      account.doubaoAsrAppId && account.doubaoAsrToken && account.doubaoAsrResourceId,
    );
    if (!asrConfigured) {
      await sendWecomTextInChunks({
        account,
        to: event.fromUser,
        content: "暂不支持语音消息，请发送文字。",
      });
      return;
    }

    let transcription: Awaited<ReturnType<typeof transcribeVoiceBuffer>>;
    try {
      // 下载企业微信语音素材（amr 格式，限 20MB）。
      const downloaded = await downloadMediaById({
        account,
        mediaId: event.mediaId ?? "",
      });
      transcription = await transcribeVoiceBuffer({
        config: {
          appId: account.doubaoAsrAppId,
          token: account.doubaoAsrToken,
          resourceId: account.doubaoAsrResourceId,
        },
        audioBuffer: downloaded.contentBytes,
        format: event.format ?? "amr",
      });
    } catch (error) {
      log?.warn?.(`wecom: voice ASR failed: ${String(error)}`);
      await sendWecomTextInChunks({
        account,
        to: event.fromUser,
        content: "语音识别失败，请重发或改用文字。",
      });
      return;
    }

    log?.info?.(
      `wecom: voice transcribed, fromUser=${event.fromUser}, durationMs=${transcription.durationMs}, inputBytes=${transcription.inputBytes}, pcmBytes=${transcription.pcmBytes}, chunkCount=${transcription.chunkCount}, text="${transcription.text.slice(0, 50)}"`,
    );

    // 将识别结果当作普通文本消息处理，保持与文字消息完全一致的 dispatch 流程。
    const keepLinks = shouldKeepLinksByUserIntent(transcription.text);
    const msgContext = core.reply.finalizeInboundContext({
      Body: transcription.text,
      RawBody: transcription.text,
      CommandBody: transcription.text,
      From: `wecom:${event.fromUser}`,
      To: `wecom:${event.fromUser}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      OriginatingChannel: "wecom",
      OriginatingTo: `wecom:${event.fromUser}`,
      ChatType: "direct",
      SenderName: event.fromUser,
      SenderId: event.fromUser,
      Provider: "wecom",
      Surface: "wecom",
      ConversationLabel: event.fromUser,
      Timestamp: Date.now(),
      CommandAuthorized: true,
    });
    await core.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: msgContext,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; body?: string }) => {
          const text = payload.text ?? payload.body ?? "";
          const cleanedText = sanitizeWecomReplyText(text, keepLinks);
          if (!cleanedText) {
            return;
          }
          await sendWecomTextInChunks({ account, to: event.fromUser, content: cleanedText });
        },
      },
    });
    return;
  }

  // 图片消息：只做本地暂存，不直接触发 LLM，等待下一条文字一起处理。
  if (event.msgType === "image") {
    const inbound = await buildInboundContext({
      account,
      event,
      core,
      log,
    });
    if (!inbound.mediaPath) {
      await sendWecomTextInChunks({
        account,
        to: event.fromUser,
        content: resolveInboundMediaFailureText(),
      });
      return;
    }
    const pendingState = addPendingMedia({
      account,
      fromUser: event.fromUser,
      mediaPath: inbound.mediaPath,
      mediaType: inbound.mediaType,
    });
    await sendWecomTextInChunks({
      account,
      to: event.fromUser,
      content: `已收到第${pendingState.imageCount}张图片`,
    });
    return;
  }

  const keepLinks = event.msgType === "text" && shouldKeepLinksByUserIntent(event.content ?? "");
  let inbound: Awaited<ReturnType<typeof buildInboundContext>>;

  if (event.msgType === "text") {
    const pendingMedia = popPendingMedia(account, event.fromUser);
    const textBody = normalizeInboundBody(event);
    if (pendingMedia.length > 0) {
      const imageCount = pendingMedia.length;
      const mediaPaths = pendingMedia.map((item) => item.mediaPath);
      const mediaTypes = pendingMedia.map((item) => item.mediaType || "image/jpeg");
      inbound = {
        body: `${textBody || "请结合附件内容进行处理。"}\n\n<media:image> 以上文字对应此前上传的${imageCount}张图片，请结合附件与文字一起理解后回复。`,
        mediaPath: mediaPaths[0],
        mediaType: mediaTypes[0],
        mediaPaths,
        mediaTypes,
        mediaUrls: mediaPaths,
      };
      log?.info?.(`wecom: merged pending media into text request, images=${imageCount}`);
    } else {
      inbound = {
        body: textBody,
      };
    }
  } else {
    inbound = await buildInboundContext({
      account,
      event,
      core,
      log,
    });
  }

  const msgContext = core.reply.finalizeInboundContext({
    Body: inbound.body,
    RawBody: inbound.body,
    CommandBody: inbound.body,
    From: `wecom:${event.fromUser}`,
    To: `wecom:${event.fromUser}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${event.fromUser}`,
    ChatType: "direct",
    SenderName: event.fromUser,
    SenderId: event.fromUser,
    Provider: "wecom",
    Surface: "wecom",
    ConversationLabel: event.fromUser,
    Timestamp: Date.now(),
    CommandAuthorized: true,
    ...(inbound.mediaPath ? { MediaPath: inbound.mediaPath } : {}),
    ...(inbound.mediaType ? { MediaType: inbound.mediaType } : {}),
    ...(inbound.mediaPaths ? { MediaPaths: inbound.mediaPaths } : {}),
    ...(inbound.mediaTypes ? { MediaTypes: inbound.mediaTypes } : {}),
    ...(inbound.mediaUrls ? { MediaUrls: inbound.mediaUrls } : {}),
  });

  await core.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgContext,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: { text?: string; body?: string }) => {
        const text = payload.text ?? payload.body ?? "";
        const cleanedText = sanitizeWecomReplyText(text, keepLinks);
        if (!cleanedText) {
          return;
        }
        await sendWecomTextInChunks({
          account,
          to: event.fromUser,
          content: cleanedText,
        });
      },
    },
  });
}

export function createWecomWebhookHandler(params: {
  accountId: string;
  cfg: OpenClawConfig;
  core: WecomCoreRuntime;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}) {
  const { accountId, cfg, core, log } = params;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const account = resolveWecomAccount(cfg, accountId);
    const query = readQuery(req);

    if (req.method === "GET") {
      const msgSignature = (query.get("msg_signature") ?? "").trim();
      const timestamp = (query.get("timestamp") ?? "").trim();
      const nonce = (query.get("nonce") ?? "").trim();
      const echoStr = query.get("echostr") ?? "";
      if (!msgSignature || !timestamp || !nonce || !echoStr) {
        return respondText(res, 400, "missing query params");
      }

      const signatureError = verifySignatureOrReject({
        account,
        msgSignature,
        timestamp,
        nonce,
        payload: echoStr,
      });
      if (signatureError) {
        return respondText(res, 403, signatureError);
      }

      if (!account.aesKey.trim()) {
        return respondText(res, 200, echoStr);
      }
      try {
        const plainEcho = decryptWecomPayload({
          aesKey: account.aesKey,
          encrypted: echoStr,
          receiveId: account.corpId,
        });
        return respondText(res, 200, plainEcho);
      } catch (error) {
        return respondText(res, 403, `echo decrypt failed: ${String(error)}`);
      }
    }

    if (req.method !== "POST") {
      return respondText(res, 405, "method not allowed");
    }

    const bodyResult = await readRequestBody(req);
    if (!bodyResult.ok) {
      return respondText(res, bodyResult.statusCode, bodyResult.error);
    }

    const msgSignature = (query.get("msg_signature") ?? "").trim();
    const timestamp = (query.get("timestamp") ?? "").trim();
    const nonce = (query.get("nonce") ?? "").trim();

    let xmlBody = bodyResult.body;
    const encrypted = readXmlTag(xmlBody, "Encrypt");
    if (encrypted) {
      const signatureError = verifySignatureOrReject({
        account,
        msgSignature,
        timestamp,
        nonce,
        payload: encrypted,
      });
      if (signatureError) {
        return respondText(res, 403, signatureError);
      }
      if (!account.aesKey.trim()) {
        return respondText(res, 403, "WECOM_AES_KEY is empty");
      }
      try {
        xmlBody = decryptWecomPayload({
          aesKey: account.aesKey,
          encrypted,
          receiveId: account.corpId,
        });
      } catch (error) {
        return respondText(res, 400, `decrypt payload failed: ${String(error)}`);
      }
    }

    const event = parseInboundEvent(xmlBody);
    if (!event) {
      const rawMsgType = (readXmlTag(xmlBody, "MsgType") ?? "unknown").toLowerCase();
      log?.info?.(`wecom: ignored inbound message, unsupported msgType=${rawMsgType}`);
      return respondText(res, 200, "success");
    }

    const dedupeKey = resolveDedupeKey(event);
    if (markDedupeAndCheckExists(dedupeKey)) {
      return respondText(res, 200, "success");
    }

    // 企业微信回调先快速 ACK，后续处理放到后台。
    respondText(res, 200, "success");
    setImmediate(() => {
      void dispatchInboundEvent({
        cfg,
        account,
        event,
        core,
        log,
      }).catch(async (error) => {
        log?.error?.(`wecom: async dispatch failed: ${String(error)}`);
        try {
          await sendWecomTextInChunks({
            account,
            to: event.fromUser,
            content: "本次处理失败，请稍后重试。",
          });
        } catch (sendError) {
          log?.error?.(`wecom: failed to send fallback text: ${String(sendError)}`);
        }
      });
    });
    return true;
  };
}
