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
    // #865: a readable-but-unvalidated attachment is analysed, not dead-ended.
    expect(prompt).toMatch(/adjunto no estructurado/i);
    expect(prompt).toMatch(/análisis rápido de lo que ves/i);
    // #1186: a market-instrument alta must resolve its price symbol first.
    expect(prompt).toMatch(/search_market_symbol/);
    expect(prompt).toMatch(/providerSymbol/);
  });

  it("pins the core read-only contract", () => {
    const prompt = buildChatSystemPrompt(null);

    expect(prompt).not.toMatch(/propose_exposure_profiles/);
    expect(prompt).not.toMatch(/list_exposure_profile_fill_targets/);
  });

  // #1169 — the onboarding surface augments the SAME contract with a present-state
  // framing, honest degradation, and the existing proposal tools (cero motor nuevo).
  describe("onboarding mode (#1169)", () => {
    const onboardingContext = {
      route: "/bienvenida",
      section: "otra" as const,
      holdingId: null,
      view: {},
    };

    it("adds the onboarding framing on the /bienvenida surface", () => {
      const prompt = buildChatSystemPrompt(onboardingContext);

      expect(prompt).toMatch(/modo onboarding/i);
      // Present-state declaration (ADR 0059): what you have today, not history.
      expect(prompt).toMatch(/0059/);
      expect(prompt).toMatch(/estado presente|qué tiene hoy/i);
      expect(prompt).toMatch(/no.*histórico de movimientos/i);
      // Both paths are first-class, never a plan B.
      expect(prompt).toMatch(/plan b/i);
      // Cero motor nuevo: it steers the existing proposal tools.
      expect(prompt).toMatch(/propose_holding/);
      expect(prompt).toMatch(/propose_reconcile/);
      // Honest degradation (#1130): name the failure and the discreet escapes.
      expect(prompt).toMatch(/1130/);
      expect(prompt).toMatch(/prefiero cargarlo a mano/i);
      expect(prompt).toMatch(/lo haré luego/i);
    });

    it("keeps the base contract underneath the onboarding framing", () => {
      const prompt = buildChatSystemPrompt(onboardingContext);

      expect(prompt).toMatch(/debes responder en español/i);
      expect(prompt).toMatch(/no inventes/i);
      expect(prompt).toMatch(/suggest_actions/);
      // The screen context is still embedded so «esto/aquí» stays grounded.
      expect(prompt).toContain("/bienvenida");
    });

    it("never leaks the onboarding framing onto ordinary surfaces", () => {
      const patrimonio = buildChatSystemPrompt({
        route: "/patrimonio",
        section: "patrimonio",
        holdingId: null,
        view: {},
      });
      expect(patrimonio).not.toMatch(/modo onboarding/i);

      expect(buildChatSystemPrompt(null)).not.toMatch(/modo onboarding/i);
    });
  });
});
