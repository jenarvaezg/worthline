import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@web/demo/read-demo-context", () => ({
  readDemoContext: async () => ({ enabled: true, now: "", persona: "familia" }),
}));

import DemoBanner from "./demo-banner";

describe("DemoBanner", () => {
  test("renders an exit control that POSTs to /demo/exit", async () => {
    const markup = renderToStaticMarkup(await DemoBanner());

    expect(markup).toContain('action="/demo/exit"');
    expect(markup).toContain('method="post"');
    expect(markup).toContain("Salir de la demo");
  });

  test("keeps the change-persona link alongside the exit control", async () => {
    const markup = renderToStaticMarkup(await DemoBanner());

    expect(markup).toContain('href="/demo"');
    expect(markup).toContain("cambiar persona");
  });
});
