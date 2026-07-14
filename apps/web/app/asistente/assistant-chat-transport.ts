import { deriveScreenContext } from "@web/asistente/screen-context";
import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from "ai";

interface MultipartBodyInput {
  attachment: File;
  messages: UIMessage[];
  screenContext: ReturnType<typeof deriveScreenContext>;
}

export function buildAssistantMultipartBody({
  attachment,
  messages,
  screenContext,
}: MultipartBodyInput): FormData {
  const body = new FormData();
  const fallbackMimeType = attachment.name.toLowerCase().endsWith(".csv")
    ? "text/csv"
    : attachment.name.toLowerCase().endsWith(".xlsx")
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "";
  const transportedAttachment =
    attachment.type === "" && fallbackMimeType
      ? new File([attachment], attachment.name, { type: fallbackMimeType })
      : attachment;
  body.set("messages", JSON.stringify(messages));
  body.set("screenContext", JSON.stringify(screenContext));
  body.set("attachment", transportedAttachment);
  return body;
}

function attachmentFromBody(body: object | undefined): File | null {
  const candidate = (body as { attachment?: unknown } | undefined)?.attachment;
  return typeof File !== "undefined" && candidate instanceof File ? candidate : null;
}

/** JSON for ordinary turns; one-shot multipart when the composer carries a file. */
export class AssistantChatTransport extends DefaultChatTransport<UIMessage> {
  constructor() {
    super({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          messages,
          screenContext: deriveScreenContext(
            window.location.pathname,
            window.location.search,
          ),
        },
      }),
    });
  }

  override async sendMessages(
    options: Parameters<DefaultChatTransport<UIMessage>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const attachment = attachmentFromBody(options.body);
    if (attachment === null) return super.sendMessages(options);

    const headers = new Headers(options.headers);
    headers.delete("content-type");
    const response = await (this.fetch ?? globalThis.fetch)(this.api, {
      method: "POST",
      body: buildAssistantMultipartBody({
        attachment,
        messages: options.messages,
        screenContext: deriveScreenContext(
          window.location.pathname,
          window.location.search,
        ),
      }),
      credentials: "same-origin",
      headers,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    if (!response.ok) throw new Error((await response.text()) || "Chat request failed.");
    if (!response.body) throw new Error("The response body is empty.");
    return this.processResponseStream(response.body);
  }
}

export const assistantChatTransport = new AssistantChatTransport();
