/**
 * 文件功能：封装豆包（火山引擎）v3 大模型流式语音识别 API，将语音 Buffer 转为文字。
 * 主要类/函数：transcribeVoiceBuffer 发送识别请求并返回结果文本。
 * 关键依赖或环境变量：WECOM_DOUBAO_ASR_APP_ID、WECOM_DOUBAO_ASR_TOKEN、WECOM_DOUBAO_ASR_RESOURCE_ID。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import ffmpegPath from "ffmpeg-static";
import WebSocket, { type RawData } from "ws";

const DOUBAO_ASR_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const BASE_ASR_TIMEOUT_MS = 30_000;
const AUDIO_CHUNK_DURATION_MS = 200;
const AUDIO_CHUNK_INTERVAL_MS = 100;
const TARGET_SAMPLE_RATE = 16_000;
const TARGET_BITS_PER_SAMPLE = 16;
const TARGET_CHANNELS = 1;
const BYTES_PER_SAMPLE = TARGET_BITS_PER_SAMPLE / 8;
const PCM_CHUNK_BYTES =
  (TARGET_SAMPLE_RATE * TARGET_CHANNELS * BYTES_PER_SAMPLE * AUDIO_CHUNK_DURATION_MS) / 1000;
const FFMPEG_TIMEOUT_MS = 45_000;

const execFileAsync = promisify(execFile);

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;
const CLIENT_FULL_REQUEST = 0b0001;
const CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
const SERVER_FULL_RESPONSE = 0b1001;
const SERVER_ERROR_RESPONSE = 0b1111;
const NO_SEQUENCE = 0b0000;
const NEG_WITHOUT_SEQUENCE = 0b0010;
const POS_SEQUENCE = 0b0001;
const NEG_WITH_SEQUENCE = 0b0011;
const NO_SERIALIZATION = 0b0000;
const JSON_SERIALIZATION = 0b0001;
const NO_COMPRESSION = 0b0000;
const GZIP_COMPRESSION = 0b0001;

export interface DoubaoAsrConfig {
  appId: string;
  token: string;
  resourceId: string;
  endpoint?: string;
}

interface DoubaoAsrResultItem {
  text?: string;
  definite?: boolean;
}

interface DoubaoAsrPayload {
  code?: number;
  message?: string;
  error?: string;
  result?:
    | { text?: string; utterances?: DoubaoAsrResultItem[] }
    | Array<{ text?: string; confidence?: number }>;
}

interface ParsedServerFrame {
  messageType: number;
  messageFlags: number;
  sequence?: number;
  errorCode?: number;
  payload: DoubaoAsrPayload;
}

type PreparedAudio = {
  pcmBuffer: Buffer;
  audioConfig: {
    format: "pcm";
    codec: "raw";
    rate: number;
    bits: number;
    channel: number;
  };
};

export interface DoubaoAsrTranscription {
  text: string;
  inputBytes: number;
  pcmBytes: number;
  durationMs: number;
  chunkCount: number;
  serverLogId?: string;
}

function normalizeRawData(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
}

function buildClientFrame(params: {
  messageType: number;
  messageFlags: number;
  serialization: number;
  compression: number;
  payload: Buffer;
}): Buffer {
  const { messageType, messageFlags, serialization, compression, payload } = params;
  const frame = Buffer.alloc(8 + payload.length);
  frame[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE;
  frame[1] = (messageType << 4) | messageFlags;
  frame[2] = (serialization << 4) | compression;
  frame[3] = 0x00;
  frame.writeUInt32BE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
}

function parseServerFrame(raw: RawData): ParsedServerFrame {
  const frame = normalizeRawData(raw);
  const headerWords = frame[0] & 0x0f;
  const headerBytes = headerWords * 4;
  const messageType = frame[1] >> 4;
  const messageFlags = frame[1] & 0x0f;
  const serialization = frame[2] >> 4;
  const compression = frame[2] & 0x0f;

  let offset = headerBytes;
  if (messageType === SERVER_ERROR_RESPONSE) {
    const errorCode = frame.readUInt32BE(offset);
    offset += 4;
    const payloadSize = frame.readUInt32BE(offset);
    offset += 4;
    const payloadBuffer = frame.subarray(offset, offset + payloadSize);
    return {
      messageType,
      messageFlags,
      errorCode,
      payload: JSON.parse(payloadBuffer.toString("utf8")) as DoubaoAsrPayload,
    };
  }

  let sequence: number | undefined;
  if (messageFlags === POS_SEQUENCE || messageFlags === NEG_WITH_SEQUENCE) {
    sequence = frame.readInt32BE(offset);
    offset += 4;
  }
  const payloadSize = frame.readUInt32BE(offset);
  offset += 4;

  let payloadBuffer = frame.subarray(offset, offset + payloadSize);
  if (compression === GZIP_COMPRESSION) {
    payloadBuffer = gunzipSync(payloadBuffer);
  } else if (compression !== NO_COMPRESSION) {
    throw new Error(`ASR 响应使用了不支持的压缩格式: ${compression}`);
  }

  if (serialization !== JSON_SERIALIZATION) {
    throw new Error(`ASR 响应使用了不支持的序列化格式: ${serialization}`);
  }

  return {
    messageType,
    messageFlags,
    sequence,
    payload: JSON.parse(payloadBuffer.toString("utf8")) as DoubaoAsrPayload,
  };
}

function sendFrame(ws: WebSocket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(frame, { binary: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function splitPcmBuffer(buffer: Buffer): Buffer[] {
  if (buffer.byteLength === 0) {
    return [];
  }
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += PCM_CHUNK_BYTES) {
    chunks.push(buffer.subarray(offset, Math.min(offset + PCM_CHUNK_BYTES, buffer.byteLength)));
  }
  return chunks;
}

function estimatePcmDurationMs(pcmBytes: number): number {
  const bytesPerSecond = TARGET_SAMPLE_RATE * TARGET_CHANNELS * BYTES_PER_SAMPLE;
  return Math.round((pcmBytes / bytesPerSecond) * 1000);
}

function resolveTempExtension(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "speex") {
    return ".spx";
  }
  return `.${normalized}`;
}

async function transcodeToPcm16kMono(params: {
  audioBuffer: Buffer;
  format: string;
}): Promise<Buffer> {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static is unavailable");
  }

  const { audioBuffer, format } = params;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wecom-asr-"));
  const inputPath = path.join(tempDir, `input${resolveTempExtension(format)}`);
  const outputPath = path.join(tempDir, "output.pcm");

  try {
    await fs.writeFile(inputPath, audioBuffer);
    await execFileAsync(
      ffmpegPath,
      [
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-sn",
        "-dn",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        String(TARGET_CHANNELS),
        "-ar",
        String(TARGET_SAMPLE_RATE),
        outputPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
    return await fs.readFile(outputPath);
  } catch (error) {
    throw new Error(`AMR 转码失败：${String(error)}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function prepareAsrAudio(params: {
  audioBuffer: Buffer;
  format: string;
}): Promise<PreparedAudio> {
  const normalizedFormat = params.format.trim().toLowerCase() || "amr";
  if (normalizedFormat === "pcm") {
    return {
      pcmBuffer: params.audioBuffer,
      audioConfig: {
        format: "pcm",
        codec: "raw",
        rate: TARGET_SAMPLE_RATE,
        bits: TARGET_BITS_PER_SAMPLE,
        channel: TARGET_CHANNELS,
      },
    };
  }

  const pcmBuffer = await transcodeToPcm16kMono({
    audioBuffer: params.audioBuffer,
    format: normalizedFormat,
  });
  return {
    pcmBuffer,
    audioConfig: {
      format: "pcm",
      codec: "raw",
      rate: TARGET_SAMPLE_RATE,
      bits: TARGET_BITS_PER_SAMPLE,
      channel: TARGET_CHANNELS,
    },
  };
}

function extractTranscript(payload: DoubaoAsrPayload): string {
  const result = payload.result;
  if (Array.isArray(result)) {
    return (result[0]?.text ?? "").trim();
  }
  if (result && typeof result === "object") {
    if (typeof result.text === "string" && result.text.trim()) {
      return result.text.trim();
    }
    if (Array.isArray(result.utterances)) {
      return result.utterances
        .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
        .filter(Boolean)
        .join("");
    }
  }
  return "";
}

function formatAsrError(message: string, serverLogId?: string): Error {
  return new Error(serverLogId ? `${message} (logid=${serverLogId})` : message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 将音频 Buffer 提交到豆包语音识别，返回识别出的文字。
 * format 默认 amr（企业微信语音消息格式），采样率 8000Hz 单声道。
 */
export async function transcribeVoiceBuffer(params: {
  config: DoubaoAsrConfig;
  audioBuffer: Buffer;
  format?: string;
}): Promise<DoubaoAsrTranscription> {
  const { config, audioBuffer, format = "amr" } = params;
  const reqId = randomUUID();
  const endpoint = config.endpoint || DOUBAO_ASR_ENDPOINT;
  const preparedAudio = await prepareAsrAudio({ audioBuffer, format });
  const audioChunks = splitPcmBuffer(preparedAudio.pcmBuffer);
  const durationMs = estimatePcmDurationMs(preparedAudio.pcmBuffer.byteLength);
  const requestTimeoutMs = Math.max(BASE_ASR_TIMEOUT_MS, durationMs + 30_000);

  if (audioChunks.length === 0) {
    throw new Error("ASR 音频为空");
  }

  const requestPayload = gzipSync(
    Buffer.from(
      JSON.stringify({
        user: { uid: "wecom-asr" },
        audio: preparedAudio.audioConfig,
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: true,
        },
      }),
      "utf8",
    ),
  );

  return await new Promise<DoubaoAsrTranscription>((resolve, reject) => {
    let settled = false;
    let latestText = "";
    let serverLogId = "";

    const finish = (done: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      done();
    };

    const rejectWith = (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      finish(() => reject(normalized));
    };

    const ws = new WebSocket(endpoint, {
      headers: {
        "X-Api-App-Key": config.appId,
        "X-Api-Access-Key": config.token,
        "X-Api-Connect-Id": reqId,
        "X-Api-Resource-Id": config.resourceId,
      },
      perMessageDeflate: false,
    });

    const timer = setTimeout(() => {
      rejectWith(formatAsrError("ASR 请求超时", serverLogId));
    }, requestTimeoutMs);

    ws.on("upgrade", (response) => {
      const logId = response.headers["x-tt-logid"];
      if (typeof logId === "string") {
        serverLogId = logId;
      }
    });

    ws.on("open", () => {
      void (async () => {
        try {
          await sendFrame(
            ws,
            buildClientFrame({
              messageType: CLIENT_FULL_REQUEST,
              messageFlags: NO_SEQUENCE,
              serialization: JSON_SERIALIZATION,
              compression: GZIP_COMPRESSION,
              payload: requestPayload,
            }),
          );
          for (let index = 0; index < audioChunks.length; index++) {
            const isFinalChunk = index === audioChunks.length - 1;
            await sendFrame(
              ws,
              buildClientFrame({
                messageType: CLIENT_AUDIO_ONLY_REQUEST,
                messageFlags: isFinalChunk ? NEG_WITHOUT_SEQUENCE : NO_SEQUENCE,
                serialization: NO_SERIALIZATION,
                compression: GZIP_COMPRESSION,
                payload: gzipSync(audioChunks[index]),
              }),
            );
            if (!isFinalChunk) {
              // v3 流式接口建议按真实采样节奏分包发送；过快会影响长语音稳定性。
              await delay(AUDIO_CHUNK_INTERVAL_MS);
            }
          }
        } catch (error) {
          rejectWith(formatAsrError(`ASR 发送请求失败：${String(error)}`, serverLogId));
        }
      })();
    });

    ws.on("message", (raw) => {
      try {
        const frame = parseServerFrame(raw);
        const payloadCode = frame.payload.code;
        const payloadMessage =
          frame.payload.message || frame.payload.error || "unknown server error";

        if (frame.messageType === SERVER_ERROR_RESPONSE) {
          const suffix =
            typeof frame.errorCode === "number"
              ? `：code=${frame.errorCode}，message=${payloadMessage}`
              : `：${payloadMessage}`;
          rejectWith(formatAsrError(`ASR 服务端错误${suffix}`, serverLogId));
          return;
        }
        if (
          typeof payloadCode === "number" &&
          payloadCode !== 0 &&
          payloadCode !== 1000 &&
          payloadCode !== 20_000_000
        ) {
          rejectWith(
            formatAsrError(
              `ASR 识别错误：code=${payloadCode}，message=${payloadMessage}`,
              serverLogId,
            ),
          );
          return;
        }

        const text = extractTranscript(frame.payload);
        if (text) {
          // 默认 full 返回会携带当前累计文本；若服务端退化为增量返回，也只在文本变长时更新。
          latestText = text.length >= latestText.length ? text : `${latestText}${text}`;
        }

        if (
          frame.messageFlags === NEG_WITH_SEQUENCE ||
          (frame.sequence !== undefined && frame.sequence < 0)
        ) {
          if (latestText) {
            finish(() =>
              resolve({
                text: latestText,
                inputBytes: audioBuffer.byteLength,
                pcmBytes: preparedAudio.pcmBuffer.byteLength,
                durationMs,
                chunkCount: audioChunks.length,
                serverLogId: serverLogId || undefined,
              }),
            );
            return;
          }
          rejectWith(formatAsrError("ASR 返回结果为空", serverLogId));
          return;
        }
      } catch (error) {
        rejectWith(formatAsrError(`ASR 响应解析失败：${String(error)}`, serverLogId));
      }
    });

    ws.on("unexpected-response", (_req, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        const suffix = body ? ` ${body.slice(0, 200)}` : "";
        rejectWith(
          formatAsrError(`ASR 握手失败：HTTP ${response.statusCode ?? 0}${suffix}`, serverLogId),
        );
      });
    });

    ws.on("error", (error) => {
      rejectWith(formatAsrError(`ASR 连接失败：${String(error)}`, serverLogId));
    });

    ws.on("close", (code, reason) => {
      if (settled) {
        return;
      }
      if (latestText) {
        finish(() =>
          resolve({
            text: latestText,
            inputBytes: audioBuffer.byteLength,
            pcmBytes: preparedAudio.pcmBuffer.byteLength,
            durationMs,
            chunkCount: audioChunks.length,
            serverLogId: serverLogId || undefined,
          }),
        );
        return;
      }
      const detail = reason.toString("utf8").trim();
      rejectWith(
        formatAsrError(
          `ASR 连接提前关闭：code=${code}${detail ? `，reason=${detail}` : ""}`,
          serverLogId,
        ),
      );
    });
  });
}
