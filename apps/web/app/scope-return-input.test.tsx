import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const url = vi.hoisted(() => ({ pathname: "/patrimonio", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => url.pathname,
  useSearchParams: () => new URLSearchParams(url.search),
}));

import ScopeReturnInput from "./scope-return-input";

afterEach(() => {
  url.pathname = "/patrimonio";
  url.search = "";
});

describe("ScopeReturnInput (#1190)", () => {
  it("builds returnTo from the live path", () => {
    const html = renderToStaticMarkup(<ScopeReturnInput />);
    expect(html).toContain('name="returnTo"');
    expect(html).toContain('value="/patrimonio"');
  });

  it("carries forward persistent query params", () => {
    url.search = "group=class";
    const html = renderToStaticMarkup(<ScopeReturnInput />);
    expect(html).toContain('value="/patrimonio?group=class"');
  });

  it("strips one-shot feedback params so banners never persist across a scope switch", () => {
    url.pathname = "/ajustes";
    url.search = "group=class&ok=saved&error=nope&v_name=foo";
    const html = renderToStaticMarkup(<ScopeReturnInput />);
    expect(html).toContain('value="/ajustes?group=class"');
    expect(html).not.toContain("ok=saved");
    expect(html).not.toContain("error=nope");
    expect(html).not.toContain("v_name");
  });
});
