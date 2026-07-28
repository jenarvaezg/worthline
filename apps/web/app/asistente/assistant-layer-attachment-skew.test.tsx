import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The JOIN #1261 broke, tested where it actually broke.
 *
 * The parse degrading and the component painting a degraded payload are covered a
 * seam each (`attachment-chat.test.ts`, `attachment-extraction-preview.test.tsx`);
 * what neither of them can see is the render site itself, and that is precisely
 * where the card disappeared — a `return preview ? <Card/> : null` that turned a
 * rejected payload into no markup at all, with no error and no gap. So this file
 * renders the real conversation surface with the real part data.
 *
 * Rendered through the onboarding variant because the floating panel ships closed
 * (only its launcher is in the markup until a click), and both surfaces share the
 * same `ConversationParts`.
 */

let chatMessages: UIMessage[] = [];

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: chatMessages,
    sendMessage: vi.fn(),
    status: "ready",
    error: undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/bienvenida",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import AssistantLayer from "./assistant-layer";
import { PREVIEW_VERSION_SKEW_MESSAGE } from "./attachment-types";

/** The card as a newer server writes it: one field this version never heard of. */
function skewedPart(result: Record<string, unknown>): UIMessage {
  return {
    id: "a1",
    parts: [
      {
        data: { fileName: "captura.png", result },
        type: "data-attachment-extraction",
      } as unknown as UIMessage["parts"][number],
    ],
    role: "assistant",
  };
}

function render(): string {
  return renderToStaticMarkup(
    <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
  );
}

beforeEach(() => {
  chatMessages = [];
});

describe("AssistantLayer · a card written by a newer server (#1261)", () => {
  test("still paints the reading when the payload grew a field", () => {
    chatMessages = [
      skewedPart({
        confidence: "low",
        message: "No reconozco en este archivo ninguno de los documentos que sé leer.",
        status: "unrecognized",
      }),
    ];

    const html = render();

    expect(html).toContain("assistantAttachmentPreview");
    expect(html).toContain("Lectura de captura.png");
    expect(html).toContain("ninguno de los documentos que sé leer");
  });

  test("says a reload is needed when the reading itself cannot be painted", () => {
    // A `valid` document with a new field: the table is unrenderable here, so the
    // card carries the honest reason instead of vanishing.
    chatMessages = [
      skewedPart({
        data: {
          documentType: "positions",
          positions: [
            {
              currency: "EUR",
              marketValueEur: 1234.56,
              name: "Fondo global",
              ticker: "VWCE",
              units: 10.5,
            },
          ],
          shiny: true,
          warnings: [],
        },
        status: "valid",
      }),
    ];

    const html = render();

    expect(html).toContain("assistantAttachmentPreview");
    expect(html).toContain("Lectura de captura.png");
    expect(html).toContain(PREVIEW_VERSION_SKEW_MESSAGE);
    // Figures this version could not validate are never painted as a reading.
    expect(html).not.toContain("VWCE");
  });
});
