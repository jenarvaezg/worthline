import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The wiring of #1418: the gate refused a call and the APP says so, instead of hoping
 * the model relays a tool result it paraphrases, softens or ignores. The decision is
 * tested in `unvalidated-evidence-notice.test.ts`; what this file proves is that the
 * note reaches the panel, once, and stays away from a thread nothing was refused in.
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

function refusedTurn(id: string): UIMessage {
  return {
    id,
    parts: [
      { text: "Entiendo, voy a intentar cargarlo.", type: "text" },
      {
        input: { liabilityId: "wl_hld_1" },
        output: { error: "unvalidated_evidence", message: "…" },
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
  test("prints the app's own notice next to the refused turn", () => {
    chatMessages = [refusedTurn("a1")];

    const html = render();

    expect(html).toContain("assistantGateNotice");
    expect(html).toContain("Aviso de worthline");
    // The two facts the user of #1418 never got: what cannot come in bulk from here,
    // and the one thing he CAN type instead of uploading another file.
    expect(html).toContain("importar-extracto");
    expect(html).toContain("una línea por fecha");
  });

  test("prints it once, however many calls the gate refuses", () => {
    chatMessages = [refusedTurn("a1"), refusedTurn("a2"), refusedTurn("a3")];

    expect(render().match(/assistantGateNotice/g)).toHaveLength(1);
  });

  test("stays silent on a conversation nothing was refused in", () => {
    chatMessages = [
      {
        id: "a1",
        parts: [{ text: "Te cuento lo que veo.", type: "text" }],
        role: "assistant",
      },
    ];

    expect(render()).not.toContain("assistantGateNotice");
  });
});
