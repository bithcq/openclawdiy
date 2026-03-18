import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/test-utils";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentRoute } from "../../../src/routing/resolve-route.js";
import { createMockServerResponse } from "../../../src/test-utils/mock-http-response.js";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import { createWecomWebhookHandler } from "./webhook-handler.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: (error?: Error) => MockIncomingMessage;
};

function createMockRequest(params: {
  body: string;
  method?: string;
  url?: string;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = params.method ?? "POST";
  req.url = params.url ?? "/api/wecom/callback";
  req.headers = { "content-type": "application/xml" };
  req.destroyed = false;
  req.destroy = ((error?: Error) => {
    req.destroyed = true;
    if (error) {
      queueMicrotask(() => req.emit("error", error));
    }
    return req;
  }) as MockIncomingMessage["destroy"];

  void Promise.resolve().then(() => {
    req.emit("data", Buffer.from(params.body, "utf-8"));
    if (!req.destroyed) {
      req.emit("end");
    }
  });

  return req;
}

describe("wecom identity links routing", () => {
  it("routes direct messages through session.identityLinks", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        wecom: {
          corpId: "corp-id",
          agentId: "1000002",
          secret: "secret",
          token: "token",
        },
      },
      session: {
        dmScope: "per-channel-peer",
        identityLinks: {
          alice: ["wecom:huangchaoqun", "telegram:111111111"],
        },
      },
    };
    const core = createPluginRuntimeMock({
      channel: {
        routing: {
          resolveAgentRoute:
            resolveAgentRoute as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
        },
      },
    });
    const handler = createWecomWebhookHandler({
      accountId: "default",
      cfg,
      core: core.channel,
    });
    const req = createMockRequest({
      body: `<xml>
  <ToUserName><![CDATA[openclaw]]></ToUserName>
  <FromUserName><![CDATA[HuangChaoQun]]></FromUserName>
  <CreateTime>1710000000</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[hello]]></Content>
  <MsgId>1234567890</MsgId>
</xml>`,
    });
    const res = createMockServerResponse();

    await handler(req, res);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("success");

    const finalizeInboundContext = core.channel.reply.finalizeInboundContext as ReturnType<
      typeof vi.fn
    >;
    expect(finalizeInboundContext).toHaveBeenCalled();
    const ctx = finalizeInboundContext.mock.calls[0]?.[0] as {
      SessionKey?: string;
      AccountId?: string;
    };
    expect(ctx.SessionKey).toBe("agent:main:wecom:direct:alice");
    expect(ctx.AccountId).toBe("default");
  });
});
