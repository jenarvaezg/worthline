/**
 * High-seam tests for the chat route (#629): fake model stream + seeded
 * in-memory store prove messages stream end-to-end, the tool reads through
 * the agent-view boundary, and no workspace writes occur. Rate-limit and
 * credential selection are seam-tested by mocking their modules — the same
 * conventions as api/mcp/route.test.ts.
 */

import {
  APICallError,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { buildFinancialContext } from "@web/agent-view/financial-context";
import { listAgentViewScopes } from "@web/agent-view/scopes";
import { parseExtractionResult } from "@web/asistente/attachment-extraction-contract";
import { extractPositionsFromImage } from "@web/asistente/attachment-image-extractor";
import { resolveChatModels } from "@web/asistente/chat-model";
import { raiseMaintainerAlert } from "@web/asistente/maintainer-alert-store";
import {
  readProviderCooldowns,
  recordProviderCooldown,
} from "@web/asistente/provider-cooldown-store";
import type { ResolvedProviderModel } from "@web/asistente/provider-model";
import type {
  AssistantProvider,
  ProviderCredentialEnvKey,
} from "@web/asistente/provider-pool";
import { countChatRequest } from "@web/asistente/rate-limit-store";
import { deriveScreenContext } from "@web/asistente/screen-context";
import { seedPersona } from "@web/demo/seed-persona";
import { JOVEN_SPEC } from "@web/demo/specs/joven";
import { readStoreTarget } from "@web/read-store-target";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

vi.mock("@web/read-store-target", () => ({ readStoreTarget: vi.fn() }));
vi.mock("@web/asistente/chat-model", () => ({ resolveChatModels: vi.fn() }));
vi.mock("@web/asistente/attachment-image-extractor", () => ({
  extractPositionsFromImage: vi.fn(),
}));
vi.mock("@web/asistente/provider-cooldown-store", () => ({
  readProviderCooldowns: vi.fn(),
  recordProviderCooldown: vi.fn(),
}));
vi.mock("@web/asistente/rate-limit-store", () => ({ countChatRequest: vi.fn() }));
vi.mock("@web/asistente/maintainer-alert-store", () => ({
  raiseMaintainerAlert: vi.fn(),
}));
vi.mock("@web/store", () => ({
  withStore: <T>(run: (store: WorthlineStore) => Promise<T>) => run(currentStore),
}));

const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

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

/** Step 1 raises a maintainer alert; step 2 streams the (still-repairing) answer. */
function maintainerAlertModel(args: Record<string, unknown>) {
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
                toolCallId: "call-alert",
                toolName: "raise_maintainer_alert",
                input: JSON.stringify(args),
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
                delta: "He anotado la sospecha y sigo con la corrección.",
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

/** Step 1 drafts a correction proposal; step 2 streams the confirmation nudge. */
function proposeCorrectionModel(args: Record<string, unknown>) {
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
                toolCallId: "call-correction",
                toolName: "propose_correction",
                input: JSON.stringify(args),
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
                delta: "Te he preparado la corrección; confírmala cuando quieras.",
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

function simpleAnswerModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "t1" },
          { type: "text-delta" as const, id: "t1", delta: text },
          { type: "text-end" as const, id: "t1" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: USAGE,
          },
        ],
      }),
    }),
  });
}

function providerError(statusCode: number, message: string) {
  return new APICallError({
    message,
    url: "https://provider.invalid/chat",
    requestBodyValues: {},
    statusCode,
  });
}

function rejectedModel(error: unknown) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw error;
    },
  });
}

function partialAnswerModel(text: string, error: unknown) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "t1" },
          { type: "text-delta" as const, id: "t1", delta: text },
          { type: "error" as const, error },
        ],
      }),
    }),
  });
}

function resolvedModel(
  provider: AssistantProvider,
  model: MockLanguageModelV4,
): ResolvedProviderModel {
  const credentialEnvKeys: Record<AssistantProvider, ProviderCredentialEnvKey> = {
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    groq: "GROQ_API_KEY",
  };
  return {
    provider,
    modelId: `${provider}-test-model`,
    credentialEnvKey: credentialEnvKeys[provider],
    label: `${provider} · ${provider}-test-model`,
    model,
  };
}

function chatRequest(body: unknown): Request {
  return new Request("http://127.0.0.1/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function attachmentRequest(
  contents: string,
  fileName = "posiciones.csv",
  mimeType = fileName.endsWith(".xlsx")
    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    : "text/csv",
): Request {
  const body = new FormData();
  body.set("messages", JSON.stringify([userMessage("¿Qué ves en estas posiciones?")]));
  body.set("screenContext", "null");
  body.set("attachment", new File([contents], fileName, { type: mimeType }));
  return new Request("http://127.0.0.1/api/chat", { method: "POST", body });
}

function imageAttachmentRequest(
  contents = "SECRET-PIXELS",
  fileName = "posiciones.png",
  mimeType = "image/png",
): Request {
  return attachmentRequest(contents, fileName, mimeType);
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
  vi.mocked(readProviderCooldowns).mockResolvedValue({
    mode: "hosted",
    deploymentKey: "preview-959",
    cooldowns: [],
  });
  vi.mocked(recordProviderCooldown).mockResolvedValue(true);
  vi.mocked(resolveChatModels).mockReturnValue([
    resolvedModel("google", fakeChatModel()),
  ]);
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
    const model = fakeChatModel();
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("google", model)]);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    // The model object may be resolved (config check), but the provider is
    // never invoked: zero doStream calls.
    expect(model.doStreamCalls.length).toBe(0);
  });

  it("returns 401 for unauthenticated callers without touching the provider", async () => {
    vi.mocked(readStoreTarget).mockResolvedValue({ kind: "unauthenticated" });
    const model = fakeChatModel();
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("google", model)]);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(401);
    expect(model.doStreamCalls.length).toBe(0);
  });

  it("rejects chat turns from the public landing surface", async () => {
    const model = fakeChatModel();
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("google", model)]);

    const response = await POST(
      chatRequest({
        messages: [userMessage("hola")],
        screenContext: deriveScreenContext("/", ""),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid_surface" });
    expect(model.doStreamCalls.length).toBe(0);
  });

  it("returns 503 when no shared credential is configured", async () => {
    vi.mocked(resolveChatModels).mockReturnValue([]);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "assistant_unavailable" });
  });

  it("rejects malformed ordinary bodies before consuming quota", async () => {
    const noMessages = await POST(chatRequest({}));
    expect(noMessages.status).toBe(400);

    const partlessMessage = await POST(
      chatRequest({ messages: [{ id: "m1", role: "user" }] }),
    );
    expect(partlessMessage.status).toBe(400);

    const notJson = await POST(
      new Request("http://127.0.0.1/api/chat", { method: "POST", body: "nope" }),
    );
    expect(notJson.status).toBe(400);

    expect(resolveChatModels).not.toHaveBeenCalled();
    expect(countChatRequest).not.toHaveBeenCalled();
    expect(readProviderCooldowns).not.toHaveBeenCalled();
  });

  it("rate-limits once, then rescues a pre-output provider rejection", async () => {
    const first = rejectedModel(providerError(429, "quota exhausted"));
    const second = simpleAnswerModel("respuesta del segundo proveedor");
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel("google", first),
      resolvedModel("cerebras", second),
    ]);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("respuesta del segundo proveedor");
    expect(countChatRequest).toHaveBeenCalledTimes(1);
    expect(first.doStreamCalls).toHaveLength(1);
    expect(second.doStreamCalls).toHaveLength(1);
    expect(recordProviderCooldown).toHaveBeenCalledWith("google", expect.any(Date));
  });

  it("skips active cooldowns observed from another instance", async () => {
    const first = simpleAnswerModel("no debe aparecer");
    const second = simpleAnswerModel("respuesta después del cooldown");
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel("google", first),
      resolvedModel("cerebras", second),
    ]);
    vi.mocked(readProviderCooldowns).mockResolvedValue({
      mode: "hosted",
      deploymentKey: "preview-959",
      cooldowns: [{ provider: "google", cooldownUntil: "2999-01-01T00:00:00.000Z" }],
    });

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("respuesta después del cooldown");
    expect(first.doStreamCalls).toHaveLength(0);
    expect(second.doStreamCalls).toHaveLength(1);
  });

  it("returns 503 without provider calls when every cooldown is active", async () => {
    const first = simpleAnswerModel("no");
    const second = simpleAnswerModel("tampoco");
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel("google", first),
      resolvedModel("cerebras", second),
    ]);
    vi.mocked(readProviderCooldowns).mockResolvedValue({
      mode: "hosted",
      deploymentKey: "production",
      cooldowns: [
        { provider: "google", cooldownUntil: "2999-01-01T00:00:00.000Z" },
        { provider: "cerebras", cooldownUntil: "2999-01-01T00:00:00.000Z" },
      ],
    });

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "assistant_unavailable" });
    expect(first.doStreamCalls).toHaveLength(0);
    expect(second.doStreamCalls).toHaveLength(0);
  });

  it("uses only the first credential and stays stateless without control plane", async () => {
    const first = rejectedModel(providerError(429, "quota exhausted"));
    const second = simpleAnswerModel("must not be attempted locally");
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel("google", first),
      resolvedModel("cerebras", second),
    ]);
    vi.mocked(readProviderCooldowns).mockResolvedValue({ mode: "local" });
    vi.mocked(recordProviderCooldown).mockResolvedValue(false);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(503);
    expect(first.doStreamCalls).toHaveLength(1);
    expect(second.doStreamCalls).toHaveLength(0);
  });

  it("never persists request-too-large as a cooldown", async () => {
    const first = rejectedModel(providerError(429, "request too large"));
    const second = simpleAnswerModel("rescued");
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel("google", first),
      resolvedModel("cerebras", second),
    ]);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("rescued");
    expect(recordProviderCooldown).not.toHaveBeenCalled();
  });

  it("uses the full pool and logs the operational cause when storage fails", async () => {
    const first = rejectedModel(providerError(503, "unavailable"));
    const second = simpleAnswerModel("safe degradation");
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel("google", first),
      resolvedModel("cerebras", second),
    ]);
    vi.mocked(readProviderCooldowns).mockRejectedValue(new Error("read timeout"));
    vi.mocked(recordProviderCooldown).mockRejectedValue(new Error("write timeout"));

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("safe degradation");
    expect(consoleError).toHaveBeenCalledWith(
      "Assistant provider cooldown read failed",
      expect.objectContaining({ cause: { name: "Error", message: "read timeout" } }),
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Assistant provider cooldown write failed",
      expect.objectContaining({ cause: { name: "Error", message: "write timeout" } }),
    );
  });

  it("returns 503 after every configured provider rejects before output", async () => {
    const first = rejectedModel(providerError(503, "unavailable"));
    const second = rejectedModel(providerError(401, "invalid credential"));
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel("google", first),
      resolvedModel("cerebras", second),
    ]);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "assistant_unavailable" });
    expect(countChatRequest).toHaveBeenCalledTimes(1);
    expect(first.doStreamCalls).toHaveLength(1);
    expect(second.doStreamCalls).toHaveLength(1);
  });

  it("keeps the existing stream error path after output and does not fail over", async () => {
    const first = partialAnswerModel("respuesta parcial", providerError(503, "late"));
    const second = simpleAnswerModel("no debe aparecer");
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel("google", first),
      resolvedModel("cerebras", second),
    ]);

    const response = await POST(chatRequest({ messages: [userMessage("hola")] }));
    const streamed = await response.text();

    expect(response.status).toBe(200);
    expect(streamed).toContain("respuesta parcial");
    expect(streamed).toContain("provider_error");
    expect(first.doStreamCalls).toHaveLength(1);
    expect(second.doStreamCalls).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith("Chat stream failed", {
      provider: "google",
      modelId: "google-test-model",
      classification: "provider_unavailable",
    });
    expect(JSON.stringify(consoleInfo.mock.calls)).not.toContain("respuesta parcial");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("respuesta parcial");
  });

  it("extracts a CSV before streaming, emits its preview and grounds the pool", async () => {
    const model = simpleAnswerModel("El fondo pesa todo el documento.");
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("google", model)]);

    const response = await POST(
      attachmentRequest(
        [
          "Ticker;Nombre;Unidades;Valor de mercado EUR;Divisa",
          'VWCE;"Fondo global";10,5;1.234,56;EUR',
        ].join("\n"),
      ),
    );
    const streamed = await response.text();

    expect(response.status).toBe(200);
    expect(streamed).toContain("data-attachment-extraction");
    expect(streamed).toContain("VWCE");
    expect(streamed).toContain("El fondo pesa todo el documento.");
    expect(JSON.stringify(model.doStreamCalls)).toContain(
      "DATOS ESTRUCTURADOS DE ADJUNTOS",
    );
    expect(JSON.stringify(model.doStreamCalls)).toContain("1234.56");
    expect(countChatRequest).toHaveBeenCalledTimes(1);
  });

  it("extracts an image through the dedicated seam and grounds the pool only with validated JSON", async () => {
    const model = simpleAnswerModel("Revisaría la lectura de ACME.");
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("cerebras", model)]);
    vi.mocked(extractPositionsFromImage).mockResolvedValue(
      parseExtractionResult({
        data: {
          documentType: "positions",
          positions: [
            {
              currency: "USD",
              marketValueEur: 1200,
              name: "Acme Incorporated",
              ticker: "ACME",
              uncertain: true,
              units: 12,
            },
          ],
          totalEur: 1200,
          warnings: ["Revisa el ticker antes de usar esta lectura."],
        },
        status: "valid",
      }),
    );

    const response = await POST(imageAttachmentRequest());
    const streamed = await response.text();
    const modelInput = JSON.stringify(model.doStreamCalls);

    expect(response.status).toBe(200);
    expect(streamed).toContain("data-attachment-extraction");
    expect(streamed).toContain("ACME");
    expect(streamed).toContain("Revisa el ticker");
    expect(streamed).toContain("Revisaría la lectura de ACME.");
    expect(modelInput).toContain("Acme Incorporated");
    expect(modelInput).not.toContain("SECRET-PIXELS");
    expect(extractPositionsFromImage).toHaveBeenCalledWith({
      bytes: expect.any(Uint8Array),
      fileName: "posiciones.png",
      mimeType: "image/png",
    });
    expect(countChatRequest).toHaveBeenCalledTimes(1);
  });

  it("renders invalid image output honestly without calling the conversational pool", async () => {
    const model = simpleAnswerModel("no debe llamarse");
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("google", model)]);
    vi.mocked(extractPositionsFromImage).mockResolvedValue(
      parseExtractionResult({
        data: { positions: [{ name: "Falta el resto" }], warnings: [] },
        status: "valid",
      }),
    );

    const response = await POST(imageAttachmentRequest());
    const streamed = await response.text();

    expect(response.status).toBe(200);
    expect(streamed).toContain("datos incompletos o malformados");
    expect(model.doStreamCalls).toHaveLength(0);
    expect(countChatRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps chat operational after the image extractor exhausts transient retries", async () => {
    const model = simpleAnswerModel("Seguimos sin la captura.");
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("cerebras", model)]);
    vi.mocked(extractPositionsFromImage).mockResolvedValue(
      parseExtractionResult({
        code: "extractor_unavailable",
        failure: "transient",
        message: "No he podido leer la captura ahora mismo. Puedes seguir conversando.",
        status: "failure",
      }),
    );

    const failedResponse = await POST(imageAttachmentRequest());
    const failedStream = await failedResponse.text();

    expect(failedResponse.status).toBe(200);
    expect(failedStream).toContain("No he podido leer la captura ahora mismo");
    expect(model.doStreamCalls).toHaveLength(0);

    const nextResponse = await POST(
      chatRequest({ messages: [userMessage("Sigamos sin la captura")] }),
    );
    expect(nextResponse.status).toBe(200);
    expect(await nextResponse.text()).toContain("Seguimos sin la captura.");
    expect(model.doStreamCalls).toHaveLength(1);
    expect(countChatRequest).toHaveBeenCalledTimes(2);
  });

  it("returns an honest nonfatal stream for unknown headers without calling the pool", async () => {
    const model = simpleAnswerModel("no debe llamarse");
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("google", model)]);

    const response = await POST(attachmentRequest("Foo;Bar\nuno;dos"));
    const streamed = await response.text();

    expect(response.status).toBe(200);
    expect(streamed).toContain("data-attachment-extraction");
    expect(streamed).toContain("No reconozco");
    expect(model.doStreamCalls).toHaveLength(0);

    const nextResponse = await POST(
      chatRequest({ messages: [userMessage("Sigamos sin el archivo")] }),
    );
    expect(nextResponse.status).toBe(200);
    expect(await nextResponse.text()).toContain("no debe llamarse");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it.each([
    {
      contents: "no es una hoja",
      fileName: "posiciones.pdf",
      mimeType: "application/pdf",
      message: "no es un PDF legible",
    },
    {
      contents: "esto no es un zip",
      fileName: "posiciones.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      message: "no se puede leer",
    },
    {
      contents: [
        "Ticker;Nombre;Unidades;Valor de mercado EUR;Divisa",
        ...Array.from(
          { length: 501 },
          (_, index) => `T${index};Posición ${index};1;1;EUR`,
        ),
      ].join("\n"),
      fileName: "demasiadas.csv",
      mimeType: "text/csv",
      message: "500 filas",
    },
  ])("keeps the conversation usable after $fileName is rejected", async ({
    contents,
    fileName,
    message,
    mimeType,
  }) => {
    const model = simpleAnswerModel("no debe llamarse");
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("google", model)]);

    const response = await POST(attachmentRequest(contents, fileName, mimeType));
    const streamed = await response.text();

    expect(response.status).toBe(200);
    expect(streamed).toContain(message);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("reuses validated structured history without accepting a file or data URL", async () => {
    const model = simpleAnswerModel("Sigo viendo el documento estructurado.");
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("google", model)]);
    const preview = {
      fileName: "posiciones.csv",
      result: {
        data: {
          documentType: "positions",
          positions: [
            {
              currency: "EUR",
              marketValueEur: 50,
              name: "Acme",
              ticker: "ACME",
              units: 2,
            },
          ],
          totalEur: 50,
          warnings: [],
        },
        status: "valid",
      },
    };

    const response = await POST(
      chatRequest({
        messages: [
          userMessage("Mira este documento"),
          {
            id: "a1",
            role: "assistant",
            parts: [{ type: "data-attachment-extraction", data: preview }],
          },
          { id: "u2", role: "user", parts: [{ type: "text", text: "¿Y ahora?" }] },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sigo viendo el documento estructurado.");
    expect(JSON.stringify(model.doStreamCalls)).toContain("ACME");
  });

  it("bounds large validated previews separately from the ordinary 16k chat limit", async () => {
    const model = simpleAnswerModel("Contexto grande recibido.");
    vi.mocked(resolveChatModels).mockReturnValue([resolvedModel("google", model)]);
    const positions = Array.from({ length: 300 }, (_, index) => ({
      currency: "EUR",
      marketValueEur: index + 1,
      name: `Posición ${index}`,
      ticker: `T${index}`,
      units: 1,
    }));

    const response = await POST(
      chatRequest({
        messages: [
          {
            id: "a1",
            role: "assistant",
            parts: [
              {
                type: "data-attachment-extraction",
                data: {
                  fileName: "grande.csv",
                  result: {
                    data: { documentType: "positions", positions, warnings: [] },
                    status: "valid",
                  },
                },
              },
            ],
          },
          { id: "u2", role: "user", parts: [{ type: "text", text: "Resume" }] },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Contexto grande recibido.");
    expect(JSON.stringify(model.doStreamCalls)).toContain("Posición 299");
  });

  it("rejects structured history beyond its dedicated context budget", async () => {
    const positions = Array.from({ length: 500 }, (_, index) => ({
      currency: "EUR",
      marketValueEur: index + 1,
      name: `Posición ${index} ${"x".repeat(200)}`,
      ticker: `T${index}`,
      units: 1,
    }));
    const previewPart = {
      type: "data-attachment-extraction",
      data: {
        fileName: "grande.csv",
        result: {
          data: { documentType: "positions", positions, warnings: [] },
          status: "valid",
        },
      },
    };

    const response = await POST(
      chatRequest({
        messages: [
          { id: "a1", role: "assistant", parts: [previewPart] },
          { id: "a2", role: "assistant", parts: [previewPart] },
          { id: "a3", role: "assistant", parts: [previewPart] },
          { id: "u2", role: "user", parts: [{ type: "text", text: "Resume" }] },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(resolveChatModels).not.toHaveBeenCalled();
    expect(countChatRequest).not.toHaveBeenCalled();
  });

  it("rejects file data URLs embedded in message history", async () => {
    const response = await POST(
      chatRequest({
        messages: [
          {
            id: "u1",
            role: "user",
            parts: [
              {
                type: "file",
                filename: "secreto.csv",
                mediaType: "text/csv",
                url: "data:text/csv;base64,U0VDUkVU",
              },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(resolveChatModels).not.toHaveBeenCalled();
    expect(countChatRequest).not.toHaveBeenCalled();
    expect(readProviderCooldowns).not.toHaveBeenCalled();
  });

  it("persists a maintainer alert through the raise_maintainer_alert tool (#1050)", async () => {
    vi.mocked(readStoreTarget).mockResolvedValue({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "token-ana",
    });
    vi.mocked(raiseMaintainerAlert).mockResolvedValue({
      alert: {
        id: "alert-1",
        workspaceId: "ws-ana",
        holdingId: "wl_hld_loan",
        category: "infidelity",
        status: "open",
        occurrenceCount: 1,
        firstSeenAt: "2026-07-15T10:00:00.000Z",
        lastSeenAt: "2026-07-15T10:00:00.000Z",
        resolutionNote: null,
        resolutionLink: null,
        resolvedAt: null,
        supersedesAlertId: null,
        createdAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:00:00.000Z",
      },
      created: true,
    });
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel(
        "google",
        maintainerAlertModel({
          holdingId: "wl_hld_loan",
          category: "infidelity",
          summary: "El saldo pintado no coincide con el recomputado.",
        }),
      ),
    ]);

    const response = await POST(
      chatRequest({ messages: [userMessage("el préstamo pinta mal")] }),
    );

    expect(response.status).toBe(200);
    const streamed = await response.text();
    expect(streamed).toContain("raise_maintainer_alert");

    // The alert reached the control-plane seam, bound to the caller's workspace,
    // with the deterministically-assembled payload.
    expect(raiseMaintainerAlert).toHaveBeenCalledTimes(1);
    const call = vi.mocked(raiseMaintainerAlert).mock.calls[0]![0];
    expect(call.workspaceId).toBe("ws-ana");
    expect(call.category).toBe("infidelity");
    expect(call.holdingId).toBe("wl_hld_loan");
    expect(call.payload).toMatchObject({
      category: "infidelity",
      summary: "El saldo pintado no coincide con el recomputado.",
    });
  });

  it("does not persist a maintainer alert for a demo (read-only) target", async () => {
    // Demo is the default target in beforeEach; the closure is never bound, so
    // the tool reports the alert as unavailable and the seam is never called.
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel(
        "google",
        maintainerAlertModel({
          holdingId: "wl_hld_loan",
          category: "infidelity",
          summary: "x",
        }),
      ),
    ]);

    const response = await POST(
      chatRequest({ messages: [userMessage("el préstamo pinta mal")] }),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(raiseMaintainerAlert).not.toHaveBeenCalled();
  });

  it("streams a correction proposal part through propose_correction (#1051)", async () => {
    vi.mocked(readStoreTarget).mockResolvedValue({
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "token-ana",
    });
    // Resolve a real holding public id from the seeded persona so the tool's
    // id resolution succeeds; an edit_config rename applies to any holding.
    const holdingId = (await currentStore.agentView.readPublicIds()).find(
      (row) => row.entityType === "holding",
    )?.publicId;
    expect(holdingId).toBeTruthy();
    vi.mocked(resolveChatModels).mockReturnValue([
      resolvedModel(
        "google",
        proposeCorrectionModel({
          correction: { kind: "edit_config", name: "Nombre corregido" },
          holdingId,
          summary: "Renombrar el holding",
        }),
      ),
    ]);

    const response = await POST(
      chatRequest({ messages: [userMessage("esto está mal escrito")] }),
    );

    expect(response.status).toBe(200);
    const streamed = await response.text();
    expect(streamed).toContain("propose_correction");
    // The tool output — a superficie C proposal in "solo-desde-hoy" mode.
    expect(streamed).toContain("solo-desde-hoy");
  });
});
