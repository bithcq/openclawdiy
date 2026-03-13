import { createServer } from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { transcribeVoiceBuffer } from "./voice-asr.js";

const CLIENT_FULL_REQUEST = 0b0001;
const CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
const SERVER_FULL_RESPONSE = 0b1001;
const NO_SEQUENCE = 0b0000;
const POS_SEQUENCE = 0b0001;
const NEG_WITHOUT_SEQUENCE = 0b0010;
const NEG_WITH_SEQUENCE = 0b0011;
const NO_SERIALIZATION = 0b0000;
const JSON_SERIALIZATION = 0b0001;
const GZIP_COMPRESSION = 0b0001;
const TARGET_PCM_CHUNK_BYTES = (16_000 * 2 * 200) / 1000;

type CapturedFrame =
  | {
      messageType: number;
      messageFlags: number;
      serialization: number;
      compression: number;
      payload: Record<string, unknown>;
    }
  | {
      messageType: number;
      messageFlags: number;
      serialization: number;
      compression: number;
      payload: Buffer;
    };

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
});

function parseClientFrame(frame: Buffer): CapturedFrame {
  const messageType = frame[1] >> 4;
  const messageFlags = frame[1] & 0x0f;
  const serialization = frame[2] >> 4;
  const compression = frame[2] & 0x0f;
  const payloadSize = frame.readUInt32BE(4);
  const payloadBytes = frame.subarray(8, 8 + payloadSize);
  const inflated = compression === GZIP_COMPRESSION ? gunzipSync(payloadBytes) : payloadBytes;

  if (serialization === JSON_SERIALIZATION) {
    return {
      messageType,
      messageFlags,
      serialization,
      compression,
      payload: JSON.parse(inflated.toString("utf8")) as Record<string, unknown>,
    };
  }

  return {
    messageType,
    messageFlags,
    serialization,
    compression,
    payload: inflated,
  };
}

function normalizeMessage(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }
  return Buffer.from(raw);
}

function buildServerResponse(
  payload: Record<string, unknown>,
  sequence: number,
  messageFlags = NEG_WITH_SEQUENCE,
): Buffer {
  const payloadBytes = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const frame = Buffer.alloc(12 + payloadBytes.length);
  frame[0] = 0x11;
  frame[1] = (SERVER_FULL_RESPONSE << 4) | messageFlags;
  frame[2] = (JSON_SERIALIZATION << 4) | GZIP_COMPRESSION;
  frame[3] = 0x00;
  frame.writeInt32BE(sequence, 4);
  frame.writeUInt32BE(payloadBytes.length, 8);
  payloadBytes.copy(frame, 12);
  return frame;
}

async function withAsrHarness(
  run: (ctx: {
    url: string;
    state: {
      headers: Record<string, string | string[] | undefined>;
      frames: CapturedFrame[];
    };
  }) => Promise<void>,
  respond?: (params: {
    ws: WebSocket;
    state: {
      headers: Record<string, string | string[] | undefined>;
      frames: CapturedFrame[];
    };
  }) => void,
): Promise<void> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const state = {
    frames: [] as CapturedFrame[],
    headers: {} as Record<string, string | string[] | undefined>,
  };

  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.headers = req.headers;
      ws.on("message", (raw) => {
        state.frames.push(parseClientFrame(normalizeMessage(raw)));
        if (respond) {
          respond({ ws, state });
          return;
        }
        const latest = state.frames.at(-1);
        if (
          latest?.messageType === CLIENT_AUDIO_ONLY_REQUEST &&
          latest.messageFlags === NEG_WITHOUT_SEQUENCE
        ) {
          ws.send(buildServerResponse({ result: { text: "测试语音" } }, -1));
        }
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to read test server address");
  }

  servers.push({
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  });

  await run({
    url: `ws://127.0.0.1:${address.port}`,
    state,
  });
}

describe("transcribeVoiceBuffer", () => {
  test("uses v3 websocket headers and sends 200ms pcm chunks", async () => {
    const audioBuffer = Buffer.alloc(TARGET_PCM_CHUNK_BYTES * 2 + 321, 7);

    await withAsrHarness(async ({ url, state }) => {
      const transcript = await transcribeVoiceBuffer({
        config: {
          appId: "2796918868",
          token: "test-token",
          resourceId: "volc.seedasr.sauc.duration",
          endpoint: url,
        },
        audioBuffer,
        format: "pcm",
      });

      expect(transcript.text).toBe("测试语音");
      expect(transcript.inputBytes).toBe(audioBuffer.byteLength);
      expect(transcript.pcmBytes).toBe(audioBuffer.byteLength);
      expect(transcript.chunkCount).toBe(3);
      expect(transcript.durationMs).toBe(410);
      expect(state.headers["x-api-app-key"]).toBe("2796918868");
      expect(state.headers["x-api-access-key"]).toBe("test-token");
      expect(state.headers["x-api-resource-id"]).toBe("volc.seedasr.sauc.duration");
      expect(typeof state.headers["x-api-connect-id"]).toBe("string");

      expect(state.frames).toHaveLength(4);

      const fullRequest = state.frames[0];
      expect(fullRequest.messageType).toBe(CLIENT_FULL_REQUEST);
      expect(fullRequest.messageFlags).toBe(NO_SEQUENCE);
      expect(fullRequest.serialization).toBe(JSON_SERIALIZATION);
      expect(fullRequest.compression).toBe(GZIP_COMPRESSION);
      expect(fullRequest.payload).toMatchObject({
        user: { uid: "wecom-asr" },
        audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
      });

      const audioRequests = state.frames.slice(1);
      expect(audioRequests).toHaveLength(3);
      expect(audioRequests[0].messageType).toBe(CLIENT_AUDIO_ONLY_REQUEST);
      expect(audioRequests[0].messageFlags).toBe(NO_SEQUENCE);
      expect(audioRequests[0].serialization).toBe(NO_SERIALIZATION);
      expect(audioRequests[0].compression).toBe(GZIP_COMPRESSION);
      expect(audioRequests[0].payload).toEqual(audioBuffer.subarray(0, TARGET_PCM_CHUNK_BYTES));

      expect(audioRequests[1].messageFlags).toBe(NO_SEQUENCE);
      expect(audioRequests[1].payload).toEqual(
        audioBuffer.subarray(TARGET_PCM_CHUNK_BYTES, TARGET_PCM_CHUNK_BYTES * 2),
      );

      expect(audioRequests[2].messageFlags).toBe(NEG_WITHOUT_SEQUENCE);
      expect(audioRequests[2].payload).toEqual(audioBuffer.subarray(TARGET_PCM_CHUNK_BYTES * 2));
    });
  });

  test("waits for final frame instead of resolving on early definite utterances", async () => {
    const audioBuffer = Buffer.alloc(TARGET_PCM_CHUNK_BYTES * 2, 9);

    await withAsrHarness(
      async ({ url, state }) => {
        const result = await transcribeVoiceBuffer({
          config: {
            appId: "2796918868",
            token: "test-token",
            resourceId: "volc.seedasr.sauc.duration",
            endpoint: url,
          },
          audioBuffer,
          format: "pcm",
        });

        expect(result.text).toBe("前半段后半段");
        expect(
          state.frames.filter((frame) => frame.messageType === CLIENT_AUDIO_ONLY_REQUEST),
        ).toHaveLength(2);
      },
      ({ ws, state }) => {
        const audioRequests = state.frames.filter(
          (frame) => frame.messageType === CLIENT_AUDIO_ONLY_REQUEST,
        );
        if (audioRequests.length === 1) {
          ws.send(
            buildServerResponse(
              {
                result: {
                  text: "前半段",
                  utterances: [{ text: "前半段", definite: true }],
                },
              },
              1,
              POS_SEQUENCE,
            ),
          );
        }
        const latest = audioRequests.at(-1);
        if (latest?.messageFlags === NEG_WITHOUT_SEQUENCE) {
          ws.send(buildServerResponse({ result: { text: "前半段后半段" } }, -1));
        }
      },
    );
  });
});
