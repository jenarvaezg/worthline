import { describe, expect, it } from "vitest";

import { buildChatSystemPrompt } from "./system-prompt";

describe("buildChatSystemPrompt", () => {
  it("embeds the screen context so the model knows what the user is looking at", () => {
    const prompt = buildChatSystemPrompt({
      route: "/patrimonio",
      section: "patrimonio",
      holdingId: null,
      view: { exp: "equity" },
    });

    expect(prompt).toContain("/patrimonio");
    expect(prompt).toContain('"exp": "equity"');
  });

  it("works without a screen context and pins the core rules", () => {
    const prompt = buildChatSystemPrompt(null);

    // The non-negotiables: Spanish default, no invented facts, read-only,
    // amounts cited verbatim (they arrive pre-formatted), and it must OPINE
    // on the user's data (ADR 0045 allows recommending; refusing to assess
    // the position is a failure, not prudence).
    expect(prompt).toMatch(/español/i);
    expect(prompt).toMatch(/debes responder en español/i);
    expect(prompt).toMatch(/si el usuario escribe en otro idioma/i);
    expect(prompt).toMatch(/no inventes/i);
    expect(prompt).toMatch(/solo lectura|no puedes modificar/i);
    expect(prompt).toMatch(/ya formateados/i);
    expect(prompt).toMatch(/nunca te niegues a valorar/i);
    expect(prompt).toMatch(/recomienda/i);
    expect(prompt).toMatch(/debes identificar.*(?:cifra|fuente interna)/i);
    // #631: it must offer typed read-only follow-ups via the action tool.
    expect(prompt).toMatch(/suggest_actions/);
    expect(prompt).toMatch(/get_financial_context.*una sola vez/i);
    expect(prompt).toMatch(/nunca imprimas json de acciones/i);
    // #1050: it must know the maintainer-alert path exists and never blocks repair.
    expect(prompt).toMatch(/raise_maintainer_alert/);
    expect(prompt).toMatch(/nunca espera a la alerta/i);
  });

  it("pins the core read-only contract", () => {
    const prompt = buildChatSystemPrompt(null);

    expect(prompt).not.toMatch(/propose_exposure_profiles/);
    expect(prompt).not.toMatch(/list_exposure_profile_fill_targets/);
  });
});
