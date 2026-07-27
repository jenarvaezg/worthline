/**
 * The two typed actions render as two different elements: a source is an anchor
 * with a real destination (so it previews on hover, opens in a new tab and shows
 * the `.navPending` ring while the route loads), a follow-up question is a button.
 * Before this both were buttons, and clicking «Ver detalle de…» produced no
 * visible change at all while the destination loaded.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));

import type { QuickAction } from "@web/asistente/assistant-actions";
import QuickActionChips from "@web/asistente/quick-action-chips";

const SOURCE: QuickAction = {
  type: "openInternalSource",
  label: "Ver detalle de la Colección Numista",
  href: "/patrimonio/wl_hld_x/editar",
};
const QUESTION: QuickAction = {
  type: "runSuggestedAnalysis",
  label: "¿Cuál es el valor total?",
  prompt: "¿Cuál es el valor total de mi colección?",
};

function markup(actions: QuickAction[], onRun = vi.fn()) {
  return renderToStaticMarkup(<QuickActionChips actions={actions} onRun={onRun} />);
}

describe("QuickActionChips", () => {
  it("renders a source as a link to its resolved internal destination", () => {
    const html = markup([SOURCE]);
    expect(html).toContain('href="/patrimonio/wl_hld_x/editar"');
    expect(html).toMatch(/<a[^>]*class="assistantChip openInternalSource"/);
  });

  it("keeps a follow-up question a button — it sends a message, it is not a place", () => {
    const html = markup([QUESTION]);
    expect(html).toContain("<button");
    expect(html).not.toContain("href=");
  });

  it("renders nothing without actions", () => {
    expect(markup([])).toBe("");
  });
});
