import { afterEach, describe, expect, it, vi } from "vitest";

describe("voice-asr ffmpeg resolution", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("falls back to system ffmpeg when ffmpeg-static binary is missing", async () => {
    vi.doMock("ffmpeg-static", () => ({ default: "/missing/ffmpeg-static" }));
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        promises: {
          ...actual.promises,
          access: vi.fn(async () => {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }),
        },
      };
    });

    const mod = await import("./voice-asr.js");

    await expect(mod.__testing.resolveFfmpegExecutable()).resolves.toBe("ffmpeg");
  });
});
