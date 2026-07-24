import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));
// ViewTransitionLink's useLinkStatus only resolves inside a real Link render;
// stub it to a plain anchor so a static render can inspect the tab classes.
vi.mock("./view-transition-link", () => ({
  default: ({ className, children }: { className: string; children: unknown }) => (
    <a className={className}>{children as never}</a>
  ),
}));

import SectionNav from "./section-nav";

afterEach(() => {
  pathname.value = "/app";
});

describe("SectionNav (#1190)", () => {
  it("renders every section as a register tab", () => {
    const html = renderToStaticMarkup(<SectionNav />);
    // Five tabs; the inactive ones carry the bare navTab class.
    expect(html).toContain('class="navTab active"');
    expect(html).toContain('class="navTab"');
    expect(html).toContain("Resumen");
    expect(html).toContain("Ajustes");
  });

  it("derives the active tab from the URL, not a prop", () => {
    pathname.value = "/patrimonio/asset_1/editar";
    const html = renderToStaticMarkup(<SectionNav />);
    // Exactly one active tab, and it is Patrimonio (nested drilldown → parent tab).
    expect(html.match(/navTab active/g)).toHaveLength(1);
    expect(html).toContain('class="navTab active">Patrimonio');
  });

  it("highlights no tab on a route outside the workspace chrome", () => {
    pathname.value = "/bienvenida";
    const html = renderToStaticMarkup(<SectionNav />);
    expect(html).not.toContain("navTab active");
  });
});
