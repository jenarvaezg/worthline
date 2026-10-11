/**
 * The feedback launcher (#1174): a visible button in the topbar that opens a
 * native modal dialog with one textarea. Structure is asserted with
 * `renderToStaticMarkup` (interaction-patterns §7); the interactive behaviour
 * lives in the pure `feedback-message.ts` and its own tests.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@web/read-store-target", () => ({ readStoreTarget: vi.fn() }));
vi.mock("./submit-feedback-action", () => ({ submitFeedbackAction: vi.fn() }));

import { readStoreTarget } from "@web/read-store-target";
import type { StoreTarget } from "@web/store-resolver";

import FeedbackLauncher from "./feedback-launcher";
import { FEEDBACK_BUTTON_LABEL } from "./feedback-message";
import FeedbackMount from "./feedback-mount";

const AUTHENTICATED = {
  dbUrl: "libsql://ws.example",
  kind: "authenticated" as const,
  token: "t",
  workspaceId: "ws-ana",
};

describe("FeedbackLauncher", () => {
  const html = renderToStaticMarkup(<FeedbackLauncher />);

  test("is a real button that announces the dialog it opens", () => {
    expect(html).toContain(`>${FEEDBACK_BUTTON_LABEL}</button>`);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('type="button"');
  });

  test("opens a labelled native dialog: one textarea, zero friction", () => {
    const labelledBy = html.match(/<dialog[^>]*aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`<h2 id="${labelledBy}">${FEEDBACK_BUTTON_LABEL}</h2>`);
    expect(html).toMatch(/<textarea[^>]*name="message"/);
    // Exactly one field the user fills in.
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).not.toMatch(/<input(?![^>]*type="hidden")/);
  });

  test("never cuts a long paste: no maxlength, the form says the limit in words", () => {
    expect(html).not.toMatch(/maxLength|maxlength/);
  });

  test("says who reads it and that the reply goes to the user's own address", () => {
    expect(html).toContain("desarrollador");
    expect(html).toContain("tu correo");
  });

  test("announces the outcome in a live region, and closing never discards", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(">Cerrar</button>");
    expect(html).not.toContain("Cancelar");
  });

  test("rides the canon's paper sheet and button recipes", () => {
    // `.coverSheet` restores the paper tokens when the dialog sits inside a cover
    // masthead (estreno, /empezar, the legal cover).
    expect(html).toContain('class="feedbackSheet coverSheet"');
    expect(html).toContain("stackForm");
    expect(html).toContain("btnSecondary");
  });
});

describe("FeedbackMount", () => {
  beforeEach(() => vi.clearAllMocks());

  test("renders for a signed-in user's own session", async () => {
    vi.mocked(readStoreTarget).mockResolvedValue(AUTHENTICATED);

    const element = await FeedbackMount();

    expect(element).not.toBeNull();
    expect(renderToStaticMarkup(element!)).toContain(FEEDBACK_BUTTON_LABEL);
  });

  test.each([
    ["the read-only demo", { kind: "demo", now: "", persona: "joven" }],
    ["the local no-auth mode", { kind: "local" }],
    [
      "an admin impersonating a workspace",
      { ...AUTHENTICATED, impersonatedEmail: "x@example.com" },
    ],
  ] satisfies Array<
    [string, StoreTarget]
  >)("stays hidden in %s", async (_label, target) => {
    vi.mocked(readStoreTarget).mockResolvedValue(target);

    expect(await FeedbackMount()).toBeNull();
  });
});
