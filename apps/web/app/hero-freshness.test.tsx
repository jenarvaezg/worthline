import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import HeroFreshness from "./hero-freshness";

const noop = async () => {};
const NOW = "2026-07-14T12:00:00.000Z";

function render(updatedAt: string | null): string {
  return renderToStaticMarkup(
    <HeroFreshness
      currentUrl="/app?view=total"
      now={NOW}
      refreshAction={noop}
      updatedAt={updatedAt}
    />,
  );
}

describe("HeroFreshness (#896)", () => {
  test("renders nothing when there is no update instant yet", () => {
    expect(render(null)).toBe("");
  });

  test("fresh: shows the calm stamp, no alert, no action", () => {
    const html = render("2026-07-14T09:00:00.000Z"); // 3 h ago

    expect(html).toContain("Actualizado hace 3 h");
    expect(html).not.toContain("No pudimos actualizar");
    expect(html).not.toContain("Actualizar</");
    expect(html).not.toContain('name="currentUrl"');
  });

  test("stale: adds the soft alert with the manual refresh action", () => {
    const html = render("2026-07-13T14:00:00.000Z"); // 22 h ago → past window

    // Stamp still present (always visible), plus the gentle alert + action.
    expect(html).toContain("Actualizado hace 22 h");
    expect(html).toContain("No pudimos actualizar los datos automáticamente");
    expect(html).toContain("Actualizar");
    // The action reuses the manual price refresh, returning to this URL.
    expect(html).toContain('name="currentUrl"');
    expect(html).toContain('value="/app?view=total"');
  });

  test("never leaks technical wording", () => {
    const html = render("2026-07-13T10:00:00.000Z"); // stale
    for (const jargon of ["cron", "UTC", "caído", "sync", "snapshot"]) {
      expect(html.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });
});
