/**
 * High-seam tests for the chat route (#629): fake model stream + seeded
 * in-memory store prove messages stream end-to-end, the tool reads through
 * the agent-view boundary, and no workspace writes occur. Rate-limit and
 * credential selection are seam-tested by mocking their modules — the same
 * conventions as api/mcp/route.test.ts.
 */
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryStore, type WorthlineStore } from "@worthline/db";

import { buildFinancialContext } from "@web/agent-view/financial-context";
import { listAgentViewScopes } from "@web/agent-view/scopes";
import { resolveChatModel } from "@web/asistente/chat-model";
import { countChatRequest } from "@web/asistente/rate-limit-store";
import { seedPersona } from "@web/demo/seed-persona";
import { JOVEN_SPEC } from "@web/demo/specs/joven";
import { readStoreTarget } from "@web/read-store-target";

import { POST } from "./route";

vi.mock("@web/read-store-target", () => ({ readStoreTarget: vi.fn() }));
vi.mock("@web/asistente/chat-model", () => ({ resolveChatModel: vi.fn() }));
vi.mock("@web/asistente/rate-limit-store", () => ({ countChatRequest: vi.fn() }));
vi.mock("@web/store", () => ({
  withStore: <T>(run: (store: WorthlineStore) => Promise<T>) => run(currentStore),
}));

const AS_OF = "2026-06-19";
const SEED_TIMEOUT_MS = 30_000;

let currentStore: WorthlineStore;

const USAGE = {
  inputTokens: { total: 3, noCache: 3 },
  outputTokens: { total: 5 },
  totalTokens: 8,
} as unknown as LanguageModelV4Usage;

/** Step 1 calls the tool; step 2 streams the grounded answer. */
function fakeChatModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: "get_financial_context",
                input: "{}",
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: undefined },
                usage: USAGE,
              },
            ]
          : [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t1" },
              {
                type: "text-delta" as const,
                id: "t1",
                delta: "Tu patrimonio neto sale de la lectura del workspace.",
              },
              { type: "text-end" as const, id: "t1" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: undefined },
                usage: USAGE,
              },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

function chatRequest(body: unknown): Request {
  return new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function userMessage(text: string) {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

beforeAll(async () => {
  currentStore = await createInMemoryStore();
  await seedPersona(currentStore, JOVEN_SPEC, AS_OF);
}, SEED_TIMEOUT_MS);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readStoreTarget).mockResolvedValue({
    kind: "demo",
    persona: "joven",
    now: AS_OF,
  });
  vi.mocked(countChatRequest).mockResolvedValue(1);
  vi.mocked(resolveChatModel).mockReturnValue(fakeChatModel());
});

describe("POST /api/chat", () => {
  it("streams a grounded answer through the tool and writes nothing", async () => {
    const scopes = await listAgentViewScopes(currentStore.agentView);
    const scopeId = (scopes.find((s) => s.isDefault) ?? scopes[0])?.id ?? "";
    const before = await buildFinancialContext(currentStore.agentView, {
      scopeId,
      asOf: AS_OF,
    });

    const response = await POST(
      chatRequest({ messages: [userMessage("¿cuál es mi patrimonio neto?")] }),
    );

    expect(response.status).toBe(200);
    const streamed = await response.text();
    expect(streamed).toContain("get_financial_context");
    expect(streamed).toContain("patrimonio neto sale de la lectura");

    const after = await buildFinancialContext(currentStore.agentView, {
      scopeId,
      asOf: AS_OF,
    });
    expect(after).toEqual(before);
  });

  it("returns 429 without calling the provider when over the limit", async () => {
    vi.mocked(countChatRequest).mockResolvedValue(999);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(vi.mocked(resolveChatModel)).not.toHaveBeenCalled();
  });

  it("returns 401 for unauthenticated callers without touching the provider", async () => {
    vi.mocked(readStoreTarget).mockResolvedValue({ kind: "unauthenticated" });

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(401);
    expect(vi.mocked(resolveChatModel)).not.toHaveBeenCalled();
  });

  it("returns 503 when no shared credential is configured", async () => {
    vi.mocked(resolveChatModel).mockReturnValue(null);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(503);
  });

  it("rejects malformed bodies before doing any work", async () => {
    const noMessages = await POST(chatRequest({}));
    expect(noMessages.status).toBe(400);

    const notJson = await POST(
      new Request("http://127.0.0.1/api/chat", { method: "POST", body: "nope" }),
    );
    expect(notJson.status).toBe(400);

    expect(vi.mocked(resolveChatModel)).not.toHaveBeenCalled();
  });
});
