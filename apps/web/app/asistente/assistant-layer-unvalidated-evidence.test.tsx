import { UNSTRUCTURED_SPREADSHEET_MESSAGE } from "@web/asistente/attachment-types";
import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The wiring of #1418: the app says what the evidence gate did, instead of hoping the
 * model relays a tool result it paraphrases, softens or ignores. The decisions are tested
 * in `unvalidated-evidence-notice.test.ts`; what this file proves is that both notes
 * reach the panel, once each, and stay away from a thread they do not apply to.
 *
 * Rendered through the onboarding variant for the same reason as its sibling: the
 * floating panel ships closed, and both surfaces share one `ConversationParts`.
 */

let chatMessages: UIMessage[] = [];
let chatStatus = "ready";

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: chatMessages,
    sendMessage: vi.fn(),
    status: chatStatus,
    error: undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/bienvenida",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import AssistantLayer from "./assistant-layer";

/** The card worthline paints for a file it can read and cannot type: the door shutting. */
function unstructuredCard(id: string): UIMessage {
  return {
    id,
    parts: [
      {
        data: {
          fileName: "cuadro.xlsx",
          result: { message: UNSTRUCTURED_SPREADSHEET_MESSAGE, status: "unrecognized" },
        },
        type: "data-attachment-extraction",
      } as unknown as UIMessage["parts"][number],
      { text: "Te comento lo que veo.", type: "text" },
    ],
    role: "assistant",
  };
}

function refusedSeriesTurn(id: string): UIMessage {
  return {
    id,
    parts: [
      {
        input: { liabilityId: "wl_hld_1" },
        output: { error: "unreadable_typed_series", message: "…" },
        state: "output-available",
        toolCallId: `call-${id}`,
        type: "tool-propose_balance_history_import",
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
  chatStatus = "ready";
});

describe("AssistantLayer · the evidence gate speaks (#1418)", () => {
  test("prints the notice as soon as the door shuts, next to the card that shut it", () => {
    chatMessages = [unstructuredCard("a1")];

    const html = render();

    expect(html).toContain("assistantGateNotice");
    expect(html).toContain("Aviso de worthline");
    // The two facts the user of #1418 never got: what cannot come in bulk from here,
    // and the one thing he CAN type instead of uploading another file.
    expect(html).toContain("importar-extracto");
    expect(html).toContain("una línea por fecha");
  });

  test("prints it once, however many files fail to read", () => {
    chatMessages = [unstructuredCard("a1"), unstructuredCard("a2")];

    expect(render().match(/assistantGateNotice/g)).toHaveLength(1);
  });

  test("tells a failed paste that worthline tried, without asking for it again", () => {
    chatMessages = [unstructuredCard("a1"), refusedSeriesTurn("a2")];

    const html = render();

    expect(html).toContain("assistantSeriesNotice");
    expect(html).toContain("no he sabido interpretarla");
    expect(html).toContain("No has perdido el trabajo");
  });

  test("stays silent on a conversation with no unreadable file in it", () => {
    chatMessages = [
      {
        id: "a1",
        parts: [{ text: "Te cuento lo que veo.", type: "text" }],
        role: "assistant",
      },
    ];

    const html = render();

    expect(html).not.toContain("assistantGateNotice");
    expect(html).not.toContain("assistantSeriesNotice");
  });
});
