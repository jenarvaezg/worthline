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
    expect(prompt).toMatch(/nunca imprimas acciones en el texto/i);
    // #1050: it must know the maintainer-alert path exists and never blocks repair.
    expect(prompt).toMatch(/raise_maintainer_alert/);
    expect(prompt).toMatch(/nunca espera a la alerta/i);
    // #865: a readable-but-unvalidated attachment is analysed, not dead-ended.
    expect(prompt).toMatch(/adjunto no estructurado/i);
    expect(prompt).toMatch(/analiza rápido lo que ves/i);
    // #1242: an attachment that could not be read keeps the turn alive — honest
    // about what happened, asking what it contains, never faking a reading.
    expect(prompt).toMatch(/adjunto no procesado/i);
    // The three verdicts are distinct: «no reconocido» is not «ilegible».
    expect(prompt).toMatch(/revisó sin extraer ninguna fila/i);
    expect(prompt).toMatch(/fuera de límites/i);
    expect(prompt).toMatch(/nunca finjas haberlo leído/i);
    expect(prompt).toMatch(/1130/);
    // #1248: the boundary itself is CODE now (unvalidated-evidence-gate.ts), so
    // the prompt keeps only tone and routing — one puntual fact is fine, the
    // whole document goes to the deterministic path — and no longer pretends to
    // forbid the alta, which would contradict PRD #1241.
    expect(prompt).toMatch(/un dato puntual/i);
    expect(prompt).toMatch(/importar-extracto/);
    expect(prompt).not.toMatch(/llevar al alta/i);
    // #1246: the unstructured rule covers captures too, and names the two
    // ambiguities that stop a proposal — identity (which holding) and the figure.
    expect(prompt).toMatch(/descripción de una captura/i);
    expect(prompt).toMatch(/a qué holding se refiere, pregunta y no propongas/i);
    expect(prompt).toMatch(/dudas de la cifra, no propongas/i);
    // And it must not send the model at a bulk-import tool the boundary will
    // reject. A real run over the Revolut capture offered `propose_reconstruction`
    // — which is on #1248's REJECT list, so the model would have had to walk it
    // back in front of the user. Narrowing the wording to «validado» was not
    // enough; the rule now says out loud that the descriptive lane has no
    // reconstruction and no bulk import at all.
    expect(prompt).toMatch(/propose_reconstruction/);
    expect(prompt).toMatch(/worthline ha VALIDADO/);
    expect(prompt).toMatch(/nunca de tu lectura de una captura/i);
    expect(prompt).toMatch(
      /NO hay reconstrucción de histórico ni importación en bloque/i,
    );
    expect(prompt).toMatch(/no las ofrezcas/i);
    // #1186: a market-instrument alta must resolve its price symbol first.
    expect(prompt).toMatch(/search_market_symbol/);
    expect(prompt).toMatch(/providerSymbol/);
    // #1245: an observed, dated early repayment is registered as the FACT; the
    // re-baseline is the last resort, not the first tool the protocol offers.
    expect(prompt).toMatch(/propose_early_repayment/);
    expect(prompt).toMatch(/pierde la causa/i);
    expect(prompt).toMatch(/último recurso/i);
    // A real run wrote «usando propose_correction» into its answer. Tool ids are
    // internal plumbing: the user reads WHAT will happen, never the function name.
    expect(prompt).toMatch(/nombres de tus tools son INTERNOS/);
    expect(prompt).toMatch(/nunca los escribas al usuario/i);
    expect(prompt).toMatch(/no cómo se llama la función/i);
    // Same run repeated its guidance three times over. Concision is a rule, and
    // «conclusión primero» alone did not stop the recap.
    expect(prompt).toMatch(/no repitas la misma guía/i);
    expect(prompt).toMatch(/ni cierres recapitulando/i);
    // #1288: a real run wrote «que he convertido a 9132 céntimos para el sistema».
    // Minor units are the same class as the ids — an argument, not prose — so the
    // plumbing rule covers both. This one is a prompt nudge and nothing more: there
    // is no way to tell an invented «9132 céntimos» from a legitimate number in the
    // text, so unlike #1263's ids no boundary can close it.
    expect(prompt).toMatch(/céntimos/i);
    expect(prompt).toMatch(/importe en euros/i);
    // #1326: a real free-tier run burned its whole monthly quota looping «¿me das
    // el OK y lo ejecuto?» / «Estado: Preparado para alta» without ever calling a
    // proposal tool. The card is the confirmation; a chat-level pre-OK is never
    // asked for, and «I will apply it» is never claimed.
    expect(prompt).toMatch(/tarjeta ES la confirmación/);
    expect(prompt).toMatch(/nunca pidas un «OK» previo/i);
    expect(prompt).toMatch(/sin haber llamado a su tool/i);
    // #1326: the same run invented which fund an in-flight subscription belonged
    // to (and its amount). Unlinked figures are asked about, never dealt out.
    expect(prompt).toMatch(/no haya vinculado explícitamente/i);
    expect(prompt).toMatch(/pregunta en vez de repartirla/i);
    // #1326: «(He corregido la presentación de las acciones sugeridas…)» reached
    // a real user. Interface/format meta-commentary is out.
    expect(prompt).toMatch(/cero meta-comentarios/i);
    // #1347: cornered by a tool that has no ISIN field, a real run promised the
    // user that «nuestro equipo» would link it. There is no team, no backoffice
    // and no ticket queue; the honest answer names the surface that DOES it.
    expect(prompt).toMatch(/no hay nadie detrás de ti/i);
    expect(prompt).toMatch(/no tiene soporte/i);
    expect(prompt).toMatch(/nunca prometas que alguien/i);
    expect(prompt).toMatch(/ISIN/);
    expect(prompt).toMatch(/en su ficha/i);
    // #1349: the chat CAN fill an empty ISIN/symbol now, so the rule that used to
    // send every identity edit to the ficha is halved, not dropped — overwriting
    // one that already has a value stays there, and the prompt must say which half.
    expect(prompt).toMatch(/que YA tiene se hace en su ficha/);
    expect(prompt).toMatch(/solo se rellena el vacío/i);
    // The old absolute («el precio/símbolo NO es un hecho editable») would teach
    // the model to refuse the fill it now has a tool for.
    expect(prompt).not.toMatch(/precio\/símbolo NO es un hecho editable/);
  });

  /**
   * PRD #1241, decision 8: what matters lives in code and is tested in CI, so the
   * prompt is for tone and must NOT grow net. #1245 added the early-repayment rule
   * and paid for it by cutting text the tools' own descriptions already carry.
   * Raising this ceiling is a decision, not a detail — a slice that needs more
   * prompt has to justify it here.
   */
  it("does not grow net (decision 8)", () => {
    // 8383 was the pre-#1245 ceiling; #1326 raised it to 9100 for three behaviour
    // failures the code cannot fully close (chat-level pre-OK loops instead of
    // emitting the card, amounts dealt out to holdings the user never linked,
    // interface meta-commentary).
    //
    // #1342 LOWERS it to 7500. The prompt was paying twice for what the tool
    // descriptions in the same request already said: it glossed all eleven
    // `propose_*` tools one by one, re-explained the maintainer alert's three
    // categories, and spelled out `suggest_actions`' own parameters. None of that
    // was a rule — every rule in those sentences is still here, in code, or in the
    // one tool it belongs to (see the ownership seam in `system-prompt.ts`).
    // Raising this number remains a decision, not a detail: a slice that needs
    // more prompt justifies it in this comment.
    //
    // #1347 raises it to 7700 for the «no hay nadie detrás de ti» rule. Code
    // closes half of that failure — `maintainer-alert-evidence.ts` now refuses an
    // alert with no discrepancy in it — but nothing in code can stop the model
    // from writing «nuestro equipo lo revisará» into its prose, which is what
    // actually reached a user on 2026-07-30. It paid for most of itself: the
    // alert bullet dropped the wording its own tool description carries, and the
    // concision bullet dropped a «cita las cifras» that duplicates the
    // traceability rule two hundred characters above it.
    //
    // #1418 raises it to 8000 for the typed-series way out. The code half of that
    // fix accepts a dated series the user writes in the chat and builds the proposal
    // from worthline's own parse of it — but nothing in code can ASK for the series,
    // and a model told «desde ese adjunto no hay importación en bloque» will keep
    // offering the dead end this ticket was filed for: a user who pasted 360 months
    // of balances that no lane could accept, five turns before anyone said so. Same
    // shape as #1347 — code closes the guarantee, the prompt has to open the door.
    //
    // #1489 raises it to 8500 for the instrument-identity rule. The code half is
    // real — `search_market_symbol` now returns the ISIN it resolved, so the bridge
    // `IE00B52MJY50 = SXR1.DE` exists in a tool result — but a tool that CAN answer
    // the question does not stop a model from never asking it: this one read a
    // statement's ISIN, its own portfolio's symbol, and told a real user they were
    // two different ETFs. Nothing in code can refuse a sentence. Same shape as
    // #1347 and #1418: the tool closes the capability, the prompt closes the claim.
    expect(buildChatSystemPrompt(null).length).toBeLessThanOrEqual(8_500);
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

  // #1170 — the SAME onboarding mode, re-launched from the ordinary panel via the
  // `repasar` flag, over a portfolio that already exists (reconcile-first).
  describe("onboarding re-run mode (#1170)", () => {
    const rerunContext = {
      route: "/patrimonio",
      section: "patrimonio" as const,
      holdingId: null,
      view: { repasar: "1" },
    };

    it("adds the onboarding framing when the repasar flag is set", () => {
      const prompt = buildChatSystemPrompt(rerunContext);

      expect(prompt).toMatch(/modo onboarding/i);
      // The re-run intro: the portfolio already exists, reconcile is primary,
      // a from-scratch alta is the degenerate case.
      expect(prompt).toMatch(/repaso/i);
      expect(prompt).toMatch(/ya tiene una cartera/i);
      expect(prompt).toMatch(/propose_reconcile/);
      expect(prompt).toMatch(/caso degenerado/i);
      // The shared present-state body still holds (ADR 0059, honest degradation).
      expect(prompt).toMatch(/0059/);
      expect(prompt).toMatch(/1130/);
      expect(prompt).toMatch(/prefiero cargarlo a mano/i);
    });

    it("keeps the base contract underneath and does not use the first-run intro", () => {
      const prompt = buildChatSystemPrompt(rerunContext);

      expect(prompt).toMatch(/debes responder en español/i);
      expect(prompt).toMatch(/suggest_actions/);
      // The empty-workspace framing belongs only to first-run.
      expect(prompt).not.toMatch(/acaba de registrarse/i);
    });
  });
});
