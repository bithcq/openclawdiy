import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sendTextMessageMock } = vi.hoisted(() => ({
  sendTextMessageMock: vi.fn(async () => ({})),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    sendTextMessage: sendTextMessageMock,
  };
});

import { wecomPlugin } from "./channel.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const cfg: OpenClawConfig = {
  channels: {
    wecom: {
      corpId: "corp-id",
      agentId: "1000002",
      secret: "secret",
      token: "token",
      aesKey: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      allowFrom: ["user-1"],
    },
  },
};

describe("wecomPlugin outbound sendText", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps top-level chunking disabled so channel sendText owns pacing", () => {
    expect(wecomPlugin.outbound?.chunker).toBeUndefined();
    expect(wecomPlugin.outbound?.textChunkLimit).toBeUndefined();
  });

  it("sends split chunks sequentially with the configured delay", async () => {
    vi.useFakeTimers();
    const firstSend = createDeferred();
    sendTextMessageMock
      .mockImplementationOnce(async () => {
        await firstSend.promise;
        return {};
      })
      .mockResolvedValue({});

    const pending = wecomPlugin.outbound!.sendText!({
      cfg,
      to: "user-1",
      text: `${"a".repeat(500)}b`,
      accountId: "default",
    });

    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTextMessageMock.mock.calls[0]?.[0]).toMatchObject({
      to: "user-1",
      content: "a".repeat(500),
    });

    firstSend.resolve();
    await Promise.resolve();

    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendTextMessageMock).toHaveBeenCalledTimes(2);
    expect(sendTextMessageMock.mock.calls[1]?.[0]).toMatchObject({
      to: "user-1",
      content: "b",
    });

    await pending;
  });
});
