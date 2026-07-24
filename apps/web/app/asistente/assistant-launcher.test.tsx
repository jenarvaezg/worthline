import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

let pathname = "/app";
let search = new URLSearchParams();

// The launcher must NOT pull the heavy layer into the eager bundle; if this
// factory ever runs during a closed-panel render, the lazy boundary is broken.
const layerFactory = vi.fn(() => {
  throw new Error("AssistantLayer must not load until the panel is opened");
});
vi.mock("next/dynamic", () => ({
  default: (loader: () => unknown) => {
    // Mirror next/dynamic: the loader is only invoked when the component renders.
    function Lazy() {
      layerFactory();
      loader();
      return null;
    }
    return Lazy;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => search,
}));

import AssistantLauncher from "./assistant-launcher";

afterEach(() => {
  pathname = "/app";
  search = new URLSearchParams();
  layerFactory.mockClear();
});

describe("AssistantLauncher · lazy floating layer (#1192)", () => {
  test("renders only the FAB on ordinary surfaces, without loading the layer", () => {
    const html = renderToStaticMarkup(<AssistantLauncher mutationsDisabledMessage="x" />);
    expect(html).toContain("assistantFab");
    expect(html).toContain('aria-label="Abrir asistente"');
    // The heavy layer chunk stays untouched while the panel is closed.
    expect(layerFactory).not.toHaveBeenCalled();
  });

  test("shows nothing on the public landing", () => {
    pathname = "/";
    const html = renderToStaticMarkup(<AssistantLauncher mutationsDisabledMessage="x" />);
    expect(html).toBe("");
    expect(layerFactory).not.toHaveBeenCalled();
  });

  test("shows nothing on the onboarding route (that surface owns its own layer)", () => {
    pathname = "/bienvenida";
    const html = renderToStaticMarkup(<AssistantLauncher mutationsDisabledMessage="x" />);
    expect(html).toBe("");
    expect(layerFactory).not.toHaveBeenCalled();
  });
});
