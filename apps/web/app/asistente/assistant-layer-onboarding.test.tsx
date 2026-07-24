import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

let pathname = "/bienvenida";

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    status: "ready",
    error: undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn() }),
}));

import AssistantLayer from "./assistant-layer";

afterEach(() => {
  pathname = "/bienvenida";
});

describe("AssistantLayer · onboarding variant (#1168)", () => {
  test("renders the estreno surface: masthead, welcome, dominant drop-zone", () => {
    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(html).toContain('aria-label="Bienvenida a worthline"');
    expect(html).toContain("onboardingMasthead");
    expect(html).toContain("Vamos a componer tu patrimonio.");
    // The drop-zone is the hero action, and it accepts the same documents the
    // assistant already understands.
    expect(html).toContain("onboardingDrop");
    expect(html).toContain('type="file"');
    expect(html).toContain(".pdf");
    expect(html).toContain(".xlsx");
  });

  test("offers the two discreet escapes — manual wizard and «lo haré luego»", () => {
    const html = renderToStaticMarkup(
      <AssistantLayer onboardingSkipAction={vi.fn()} variant="onboarding" />,
    );

    expect(html).toContain('href="/patrimonio/anadir"');
    expect(html).toContain("Prefiero cargarlo a mano");
    // The skip is a form (the server action stamps onboarded), not a bare link.
    expect(html).toContain("<form");
    expect(html).toContain("Lo haré luego");
  });

  test("falls back to a plain dashboard link when no skip action is wired", () => {
    const html = renderToStaticMarkup(<AssistantLayer variant="onboarding" />);

    expect(html).toContain('href="/app"');
    expect(html).toContain("Lo haré luego");
  });

  test("the floating variant never shows on the onboarding route", () => {
    // No FAB behind the onboarding surface — that route IS the onboarding variant.
    const html = renderToStaticMarkup(<AssistantLayer />);
    expect(html).toBe("");
  });

  test("the floating variant still shows its FAB on ordinary surfaces", () => {
    pathname = "/app";
    const html = renderToStaticMarkup(<AssistantLayer />);
    expect(html).toContain("assistantFab");
    expect(html).toContain('aria-label="Abrir asistente"');
  });
});
