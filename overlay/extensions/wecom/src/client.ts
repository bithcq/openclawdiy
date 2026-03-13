/**
 * 文件功能：封装企业微信接口调用（token、发送消息、上传下载媒体）。
 * 主要类/函数：sendTextMessage/sendImageMessage/downloadMediaById。
 * 关键依赖或环境变量：WECOM_CORP_ID、WECOM_AGENT_ID、WECOM_SECRET、WECOM_PROXY_URL。
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
import type { ResolvedWecomAccount, WecomDownloadedMedia } from "./types.js";

const WECOM_API_BASE = "https://qyapi.weixin.qq.com/cgi-bin";
const TOKEN_SAFETY_MARGIN_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 60_000;

type WecomFetch = (input: string, init?: RequestInit) => Promise<Response>;

type TokenCacheEntry = {
  accessToken: string;
  expireAtMs: number;
};

const proxyFetchCache = new Map<string, WecomFetch>();
const tokenCache = new Map<string, TokenCacheEntry>();

function resolveWecomFetch(proxyUrl?: string): WecomFetch {
  const trimmed = (proxyUrl ?? "").trim();
  if (!trimmed) {
    return async (input, init) => await fetch(input, init);
  }
  const cached = proxyFetchCache.get(trimmed);
  if (cached) {
    return cached;
  }
  const agent = new ProxyAgent(trimmed);
  const fetcher: WecomFetch = async (input, init) =>
    (await undiciFetch(input, {
      ...(init ?? {}),
      dispatcher: agent,
    } as UndiciRequestInit)) as unknown as Response;
  proxyFetchCache.set(trimmed, fetcher);
  return fetcher;
}

function tokenCacheKey(account: ResolvedWecomAccount): string {
  return `${account.corpId}::${account.secret}`;
}

async function fetchWithTimeout(
  fetcher: WecomFetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort("timeout"), timeoutMs);
  try {
    return await fetcher(url, {
      ...init,
      signal: abortController.signal,
    });
  } catch (error) {
    // 统一把底层超时报错转成可读文本，便于上层提示用户。
    if (
      abortController.signal.aborted ||
      (error instanceof Error && error.name.toLowerCase().includes("abort"))
    ) {
      throw new Error(`request timeout (${timeoutMs}ms): ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const rawText = await response.text();
  if (!rawText.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    return parsed;
  } catch {
    throw new Error(`invalid json response: ${rawText.slice(0, 300)}`);
  }
}

async function requestWecomJson(params: {
  account: ResolvedWecomAccount;
  path: string;
  searchParams?: URLSearchParams;
  method?: "GET" | "POST";
  jsonBody?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const { account, path, method = "GET", jsonBody } = params;
  const url = new URL(`${WECOM_API_BASE}/${path}`);
  for (const [key, value] of (params.searchParams ?? new URLSearchParams()).entries()) {
    url.searchParams.set(key, value);
  }

  const fetcher = resolveWecomFetch(account.proxyUrl);
  const response = await fetchWithTimeout(fetcher, url.toString(), {
    method,
    headers: jsonBody
      ? {
          "Content-Type": "application/json",
        }
      : undefined,
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`wecom http ${response.status}: ${text.slice(0, 300)}`);
  }
  return await readJsonResponse(response);
}

function assertWecomSuccess(payload: Record<string, unknown>, action: string): void {
  const errCode = Number(payload.errcode ?? 0);
  if (errCode === 0) {
    return;
  }
  const errMsg = String(payload.errmsg ?? "unknown error");
  throw new Error(`${action} failed: errcode=${errCode}, errmsg=${errMsg}`);
}

async function fetchAccessToken(account: ResolvedWecomAccount): Promise<string> {
  const key = tokenCacheKey(account);
  const now = Date.now();
  const cached = tokenCache.get(key);
  if (cached && cached.expireAtMs > now) {
    return cached.accessToken;
  }

  const payload = await requestWecomJson({
    account,
    path: "gettoken",
    searchParams: new URLSearchParams({
      corpid: account.corpId,
      corpsecret: account.secret,
    }),
  });
  assertWecomSuccess(payload, "gettoken");

  const accessToken = String(payload.access_token ?? "").trim();
  if (!accessToken) {
    throw new Error("gettoken failed: access_token is empty");
  }

  const expiresIn = Math.max(120, Number(payload.expires_in ?? 7200));
  tokenCache.set(key, {
    accessToken,
    expireAtMs: now + (expiresIn - TOKEN_SAFETY_MARGIN_SECONDS) * 1000,
  });
  return accessToken;
}

function resolveToUser(account: ResolvedWecomAccount, to?: string): string {
  const resolved = (to ?? "").trim() || account.messageToUser;
  return resolved || "@all";
}

function resolveAgentId(account: ResolvedWecomAccount): number {
  const id = Number(account.agentId);
  if (!Number.isFinite(id)) {
    throw new Error("WECOM_AGENT_ID is invalid");
  }
  return id;
}

export async function sendTextMessage(params: {
  account: ResolvedWecomAccount;
  to?: string;
  content: string;
}): Promise<Record<string, unknown>> {
  const { account, to, content } = params;
  const accessToken = await fetchAccessToken(account);
  const payload = await requestWecomJson({
    account,
    path: "message/send",
    searchParams: new URLSearchParams({
      access_token: accessToken,
    }),
    method: "POST",
    jsonBody: {
      touser: resolveToUser(account, to),
      msgtype: "text",
      agentid: resolveAgentId(account),
      text: { content },
      safe: 0,
    },
  });
  assertWecomSuccess(payload, "message.send[text]");
  return payload;
}

export async function sendImageMessage(params: {
  account: ResolvedWecomAccount;
  to?: string;
  mediaId: string;
}): Promise<Record<string, unknown>> {
  const { account, to, mediaId } = params;
  const cleanedMediaId = mediaId.trim();
  if (!cleanedMediaId) {
    throw new Error("send image failed: media_id is empty");
  }

  const accessToken = await fetchAccessToken(account);
  const payload = await requestWecomJson({
    account,
    path: "message/send",
    searchParams: new URLSearchParams({
      access_token: accessToken,
    }),
    method: "POST",
    jsonBody: {
      touser: resolveToUser(account, to),
      msgtype: "image",
      agentid: resolveAgentId(account),
      image: { media_id: cleanedMediaId },
      safe: 0,
    },
  });
  assertWecomSuccess(payload, "message.send[image]");
  return payload;
}

export async function uploadMediaFromBuffer(params: {
  account: ResolvedWecomAccount;
  mediaType: "image";
  contentBytes: Buffer;
  fileName: string;
  contentType?: string;
}): Promise<{ mediaId: string }> {
  const { account, mediaType, contentBytes, fileName, contentType } = params;
  const accessToken = await fetchAccessToken(account);

  const form = new FormData();
  const blob = new Blob([contentBytes], {
    type: contentType || "application/octet-stream",
  });
  form.set("media", blob, fileName || "upload.bin");

  const fetcher = resolveWecomFetch(account.proxyUrl);
  const uploadUrl = new URL(`${WECOM_API_BASE}/media/upload`);
  uploadUrl.searchParams.set("access_token", accessToken);
  uploadUrl.searchParams.set("type", mediaType);

  const response = await fetchWithTimeout(fetcher, uploadUrl.toString(), {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`media.upload failed: http ${response.status} ${text.slice(0, 300)}`);
  }
  const payload = await readJsonResponse(response);
  assertWecomSuccess(payload, "media.upload");

  const mediaId = String(payload.media_id ?? "").trim();
  if (!mediaId) {
    throw new Error("media.upload failed: media_id is empty");
  }
  return { mediaId };
}

export async function uploadMediaFromUrl(params: {
  account: ResolvedWecomAccount;
  mediaType: "image";
  mediaUrl: string;
}): Promise<{ mediaId: string }> {
  const { account, mediaType, mediaUrl } = params;
  const fetcher = resolveWecomFetch(account.proxyUrl);
  const response = await fetchWithTimeout(fetcher, mediaUrl, {
    method: "GET",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `download outbound media failed: http ${response.status} ${text.slice(0, 300)}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  const fileName = (() => {
    const fromUrl = mediaUrl.split("?")[0] ?? "upload.bin";
    const last = fromUrl.split("/").pop() ?? "upload.bin";
    return last.trim() || "upload.bin";
  })();

  const contentBytes = Buffer.from(await response.arrayBuffer());
  return await uploadMediaFromBuffer({
    account,
    mediaType,
    contentBytes,
    fileName,
    contentType,
  });
}

function parseFileNameFromDisposition(disposition: string): string | undefined {
  const filenameStar = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (filenameStar?.[1]) {
    return decodeURIComponent(filenameStar[1].trim().replace(/^"|"$/g, ""));
  }
  const filename = disposition.match(/filename="?([^";]+)"?/i);
  if (filename?.[1]) {
    return filename[1].trim();
  }
  return undefined;
}

export async function downloadMediaById(params: {
  account: ResolvedWecomAccount;
  mediaId: string;
}): Promise<WecomDownloadedMedia> {
  const { account, mediaId } = params;
  const cleanedMediaId = mediaId.trim();
  if (!cleanedMediaId) {
    throw new Error("media_id is empty");
  }

  const accessToken = await fetchAccessToken(account);
  const fetcher = resolveWecomFetch(account.proxyUrl);
  const downloadUrl = new URL(`${WECOM_API_BASE}/media/get`);
  downloadUrl.searchParams.set("access_token", accessToken);
  downloadUrl.searchParams.set("media_id", cleanedMediaId);

  const response = await fetchWithTimeout(fetcher, downloadUrl.toString(), {
    method: "GET",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`media.get failed: http ${response.status} ${text.slice(0, 300)}`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    const payload = await readJsonResponse(response);
    assertWecomSuccess(payload, "media.get");
    throw new Error("media.get returned json without binary content");
  }

  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = parseFileNameFromDisposition(disposition) ?? `${cleanedMediaId}.bin`;
  const contentBytes = Buffer.from(await response.arrayBuffer());

  return {
    fileName,
    contentType: contentType || "application/octet-stream",
    contentBytes,
  };
}

export async function downloadMediaFromUrl(params: {
  account: ResolvedWecomAccount;
  mediaUrl: string;
  fileName?: string;
}): Promise<WecomDownloadedMedia> {
  const { account, mediaUrl, fileName } = params;
  const url = mediaUrl.trim();
  if (!url) {
    throw new Error("media_url is empty");
  }

  const fetcher = resolveWecomFetch(account.proxyUrl);
  const response = await fetchWithTimeout(fetcher, url, {
    method: "GET",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`media url download failed: http ${response.status} ${text.slice(0, 300)}`);
  }

  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const disposition = response.headers.get("content-disposition") ?? "";
  // 优先级：调用方指定 > 头部文件名 > URL 路径推断。
  const resolvedFileName =
    fileName?.trim() ||
    parseFileNameFromDisposition(disposition) ||
    (() => {
      const pathname = new URL(url).pathname;
      const fromPath = pathname.split("/").pop() ?? "media.bin";
      return fromPath.trim() || "media.bin";
    })();

  const contentBytes = Buffer.from(await response.arrayBuffer());
  return {
    fileName: resolvedFileName,
    contentType: contentType || "application/octet-stream",
    contentBytes,
  };
}
