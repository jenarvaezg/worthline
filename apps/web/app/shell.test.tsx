import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ViewTransitionLink reads the live pathname; stub it for a static render.
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
// SignOutButton is an async server component (awaits the request store), which
// renderToStaticMarkup cannot resolve; stub it — it is irrelevant to the band.
vi.mock("./sign-out-button", () => ({ default: () => null }));

import Shell from "./shell";

/**
 * The global shell warning band was retired (#665, PRD #654 S3): attention now
 * lives in the home hero's data-health alert, not a rail shouting on every page.
 * These tests pin that the shell renders no warning band while keeping its chrome.
 */
describe("Shell", () => {
  const persistence = {
    checkedAt: "2026-07-02T10:00:00.000Z",
    displayPath: ".local/worthline/worthline.sqlite",
  };

  it("renders no warning band", () => {
    const html = renderToStaticMarkup(
      <Shell
        activeSection="resumen"
        currentPageUrl="/app"
        persistence={persistence}
        scopes={[]}
        selectedScopeId={undefined}
      >
        <p>contenido</p>
      </Shell>,
    );
    expect(html).not.toContain("warningBand");
    expect(html).not.toContain('aria-label="Avisos"');
    // The shell chrome and page content still render.
    expect(html).toContain("worthline");
    expect(html).toContain("contenido");
  });

  it("renders the section nav as register tabs (#910)", () => {
    const html = renderToStaticMarkup(
      <Shell
        activeSection="patrimonio"
        currentPageUrl="/patrimonio"
        persistence={persistence}
        scopes={[]}
        selectedScopeId={undefined}
      >
        <p>contenido</p>
      </Shell>,
    );
    // Every section link is a .navTab; the active one carries the active modifier.
    expect(html).toContain('class="navTab"');
    expect(html).toContain('class="navTab active"');
  });

  it("renders the scope selector as a segmented control (#910)", () => {
    const html = renderToStaticMarkup(
      <Shell
        activeSection="resumen"
        currentPageUrl="/app"
        persistence={persistence}
        scopes={[
          { id: "jorge", label: "Jorge", type: "member" },
          { id: "hogar", label: "Hogar", type: "household" },
        ]}
        selectedScopeId="jorge"
      >
        <p>contenido</p>
      </Shell>,
    );
    expect(html).toContain('class="scopeTabs segmented"');
    expect(html).toContain("scopeTabBtn active");
  });
});
