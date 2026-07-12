import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APICallError,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { resolveChatModels } from "@web/asistente/chat-model";
import type { ResolvedProviderModel } from "@web/asistente/provider-model";
import type {
  AssistantProvider,
  ProviderCredentialEnvKey,
} from "@web/asistente/provider-pool";
import { countChatRequest } from "@web/asistente/rate-limit-store";
import { readStoreTarget } from "@web/read-store-target";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

vi.mock("@web/read-store-target", () => ({ readStoreTarget: vi.fn() }));
vi.mock("@web/asistente/chat-model", () => ({ resolveChatModels: vi.fn() }));
vi.mock("@web/asistente/rate-limit-store", () => ({ countChatRequest: vi.fn() }));
vi.mock("@web/store", () => ({ withStore: vi.fn() }));

vi.spyOn(console, "info").mockImplementation(() => undefined);
vi.spyOn(console, "error").mockImplementation(() => undefined);

const USAGE = {
  inputTokens: { total: 1, noCache: 1 },
  outputTokens: { total: 1 },
  totalTokens: 2,
} as unknown as LanguageModelV4Usage;

const originalEnv = {
  controlPlane: process.env["WORTHLINE_CONTROL_PLANE_DB_URL"],
  deployment: process.env["WORTHLINE_CHAT_DEPLOYMENT_KEY"],
};
let tempDir: string;

function streamFor(text: string): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: text },
        { type: "text-end" as const, id: "t1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: USAGE,
        },
      ]) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function answerModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: async () => ({ stream: streamFor(text) }) });
}

function rejectedModel(message: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new APICallError({
        message,
        url: "https://provider.invalid/chat",
        requestBodyValues: {},
        statusCode: 429,
      });
    },
  });
}

function recoveringModel(): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      if (call === 1) {
        throw new APICallError({
          message: "quota exhausted",
          url: "https://provider.invalid/chat",
          requestBodyValues: {},
          statusCode: 429,
        });
      }
      return { stream: streamFor("primary recovered") };
    },
  });
}

function resolved(
  provider: AssistantProvider,
  model: MockLanguageModelV4,
): ResolvedProviderModel {
  const keys: Record<AssistantProvider, ProviderCredentialEnvKey> = {
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    groq: "GROQ_API_KEY",
  };
  return {
    provider,
    modelId: `${provider}-smoke`,
    credentialEnvKey: keys[provider],
    label: `${provider} · smoke`,
    model,
  };
}

function request(): Request {
  return new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hola" }] }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
  tempDir = mkdtempSync(join(tmpdir(), "worthline-cooldown-smoke-"));
  process.env["WORTHLINE_CONTROL_PLANE_DB_URL"] = `file:${join(tempDir, "cp.db")}`;
  process.env["WORTHLINE_CHAT_DEPLOYMENT_KEY"] = "demo-smoke";
  vi.mocked(readStoreTarget).mockResolvedValue({
    kind: "demo",
    persona: "joven",
    now: "2026-07-12",
  });
  vi.mocked(countChatRequest).mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  if (originalEnv.controlPlane === undefined) {
    delete process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  } else {
    process.env["WORTHLINE_CONTROL_PLANE_DB_URL"] = originalEnv.controlPlane;
  }
  if (originalEnv.deployment === undefined) {
    delete process.env["WORTHLINE_CHAT_DEPLOYMENT_KEY"];
  } else {
    process.env["WORTHLINE_CHAT_DEPLOYMENT_KEY"] = originalEnv.deployment;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("provider cooldown controlled demo smoke", () => {
  it("persists fallback across requests and restores the provider after expiry", async () => {
    const primary = recoveringModel();
    const secondary = answerModel("secondary answered");
    vi.mocked(resolveChatModels).mockReturnValue([
      resolved("google", primary),
      resolved("cerebras", secondary),
    ]);

    const first = await POST(request());
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("secondary answered");
    expect(primary.doStreamCalls).toHaveLength(1);

    const second = await POST(request());
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("secondary answered");
    expect(primary.doStreamCalls).toHaveLength(1);

    vi.setSystemTime(new Date("2026-07-12T10:01:01.000Z"));
    const recovered = await POST(request());
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toContain("primary recovered");
    expect(primary.doStreamCalls).toHaveLength(2);
  });

  it("isolates another deployment and returns 503 when its pool exhausts", async () => {
    process.env["WORTHLINE_CHAT_DEPLOYMENT_KEY"] = "another-demo";
    const first = rejectedModel("quota exhausted");
    const second = rejectedModel("quota exhausted");
    vi.mocked(resolveChatModels).mockReturnValue([
      resolved("google", first),
      resolved("cerebras", second),
    ]);

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "assistant_unavailable" });
    expect(first.doStreamCalls).toHaveLength(1);
    expect(second.doStreamCalls).toHaveLength(1);
  });
});
