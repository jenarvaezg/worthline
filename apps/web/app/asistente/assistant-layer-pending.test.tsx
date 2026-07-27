import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The wiring of #1286: the in-flight signal is actually rendered next to the
 * conversation, and it goes away when there is nothing to wait for. The rule itself
 * is tested in `assistant-pending.test.ts`; what this file proves is that the panel
 * shows it — the whole point of the ticket was that the only existing signal was
 * `srOnly` and therefore invisible.
 *
 * Rendered through the onboarding variant for the same reason as the #1262 test:
 * the floating panel ships closed, and both surfaces share `ConversationParts`.
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
import {
  ASSISTANT_PENDING_READING,
  ASSISTANT_PENDING_THINKING,
} from "./assistant-pending";
import { userTurnText } from "./attachment-notice";

beforeEach(() => {
  chatMessages = [];
  chatStatus = "ready";
});

function userTurn(text: string): UIMessage {
  return { id: "u1", parts: [{ text, type: "text" }], role: "user" };
}

function markup(): string {
  return renderToStaticMarkup(<AssistantLayer variant="onboarding" />);
}

describe("AssistantLayer · visible pending signal (#1286)", () => {
  test("shows a visible signal while a turn is in flight", () => {
    chatMessages = [userTurn("¿Cómo va mi patrimonio?")];
    chatStatus = "submitted";

    const html = markup();

    expect(html).toContain(ASSISTANT_PENDING_THINKING);
    expect(html).toContain("assistantPending");
    // The ring is the existing navigation idiom, not a second spinner.
    expect(html).toContain("navPending");
  });

  test("names the long wait when the turn carried an attachment", () => {
    chatMessages = [userTurn(userTurnText("mira esto", "captura.jpg"))];
    chatStatus = "submitted";

    expect(markup()).toContain(ASSISTANT_PENDING_READING);
  });

  test("does not announce twice: the visible twin is hidden from assistive tech", () => {
    chatMessages = [userTurn("hola")];
    chatStatus = "submitted";

    const html = markup();

    // The srOnly live region keeps its announcement…
    expect(html).toContain("El asistente está respondiendo.");
    // …and the visible line is aria-hidden, so a screen reader hears it once.
    expect(html).toMatch(/aria-hidden="true"[^>]*class="assistantPending"/);
  });

  test("shows nothing when no turn is in flight", () => {
    chatMessages = [
      userTurn("hola"),
      {
        id: "a1",
        parts: [{ text: "Tu patrimonio es…", type: "text" }],
        role: "assistant",
      },
    ];

    const html = markup();

    expect(html).not.toContain("assistantPending");
    expect(html).not.toContain(ASSISTANT_PENDING_THINKING);
  });
});
