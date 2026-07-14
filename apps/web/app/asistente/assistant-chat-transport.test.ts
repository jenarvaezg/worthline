import type { UIMessage } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AssistantChatTransport,
  buildAssistantMultipartBody,
} from "./assistant-chat-transport";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assistant attachment transport", () => {
  test("keeps the binary in multipart and out of chat messages", () => {
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Compara estas posiciones" }],
      },
    ];
    const file = new File(["SECRET-BINARY"], "cartera.csv", { type: "text/csv" });

    const body = buildAssistantMultipartBody({
      attachment: file,
      messages,
      screenContext: {
        holdingId: null,
        route: "/patrimonio",
        section: "patrimonio",
        view: {},
      },
    });

    expect(body.get("attachment")).toBe(file);
    expect(body.get("messages")).toBe(JSON.stringify(messages));
    expect(String(body.get("messages"))).not.toContain("SECRET-BINARY");
    expect(body.get("screenContext")).toContain("patrimonio");
  });

  test("supplies a safe MIME fallback when the browser leaves CSV type blank", () => {
    const file = new File(["Ticker;Nombre"], "cartera.csv");
    const body = buildAssistantMultipartBody({
      attachment: file,
      messages: [],
      screenContext: {
        holdingId: null,
        route: "/patrimonio",
        section: "patrimonio",
        view: {},
      },
    });

    expect((body.get("attachment") as File).type).toBe("text/csv");
  });

  test.each([
    ["captura.png", "image/png"],
    ["captura.jpg", "image/jpeg"],
    ["captura.jpeg", "image/jpeg"],
    ["captura.webp", "image/webp"],
    ["captura.heic", "image/heic"],
    ["captura.heif", "image/heif"],
  ])("supplies a safe MIME fallback for %s", (fileName, expectedMimeType) => {
    const file = new File(["IMAGE-BYTES"], fileName);
    const body = buildAssistantMultipartBody({
      attachment: file,
      messages: [],
      screenContext: {
        holdingId: null,
        route: "/patrimonio",
        section: "patrimonio",
        view: {},
      },
    });

    expect((body.get("attachment") as File).type).toBe(expectedMimeType);
  });

  test("the concrete transport posts the selected file once as multipart", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new ReadableStream({ start: (controller) => controller.close() })),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { pathname: "/patrimonio", search: "" },
    });
    const transport = new AssistantChatTransport();
    const file = new File(["Ticker;Nombre"], "cartera.csv", { type: "text/csv" });

    await transport.sendMessages({
      abortSignal: undefined,
      body: { attachment: file },
      chatId: "chat-1",
      messageId: undefined,
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Analiza la cartera" }],
        },
      ],
      trigger: "submit-message",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.body).toBeInstanceOf(FormData);
    expect((request.body as FormData).get("attachment")).toBeInstanceOf(File);
    expect((request.headers as Headers).has("content-type")).toBe(false);
  });
});
