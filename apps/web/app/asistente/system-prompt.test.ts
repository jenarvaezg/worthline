import { describe, expect, it } from "vitest";

import { ATTACHMENT_BLOCK_NAMES } from "./attachment-types";
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
    // #1514: the positive counterweight. Before it, «hoja de cálculo» appeared
    // exactly once in the whole prompt and it was inside the sentence that says
    // «no», so a VALIDATED .xlsx triggered the surface association
    // xlsx → hoja de cálculo → «eso va por la web» and a real user was sent to
    // upload the file the assistant had just read. Hence the words the rule must
    // carry: the same «hoja de cálculo», this time on the side that says «sí».
    expect(prompt).toMatch(/validado ese documento —también si es una hoja de cálculo/);
    expect(prompt).toMatch(/propón en ESTE turno/);
    expect(prompt).toMatch(
      /nunca mandes a subir en otra pantalla lo que acabas de leer/i,
    );
    // It says what to do when the document is short of a datum, because the honest
    // answer is a question and never a bounce to the web door.
    expect(prompt).toMatch(/lo que falte, pregúntalo aquí/i);
    // And the #865/#1248 frontier keeps its content untouched — only its trigger
    // is now spelled out as the block, which is what the code actually emits.
    expect(prompt).toMatch(/el bloque «ADJUNTO NO ESTRUCTURADO»/);
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
    // #1524: the asymmetry. «Yo no puedo» and «no sé dónde» are sayable; «worthline
    // no lo hace» is not — and the reason has to be IN the prompt, because a model
    // that thinks it is describing a product will describe it confidently.
    expect(prompt).toMatch(/asimétrico con las capacidades/i);
    expect(prompt).toMatch(/«worthline no lo hace» NO/);
    expect(prompt).toMatch(/no lo sabes/i);
    expect(prompt).toMatch(/tú eres la app hablando/i);
    // The invented architecture («worthline no tiene un libro de contabilidad de
    // ingresos/gastos») was the second turn of the same failure, not a slip.
    expect(prompt).toMatch(/de memoria cómo está construida/i);
    // The eviction: he was told to use a spreadsheet for something the app does.
    expect(prompt).toMatch(/hoja de cálculo/i);
    expect(prompt).toMatch(/herramienta externa/i);
    // And the positive half: «¿dónde meto X?» over a holding is a READ, not a recall.
    expect(prompt).toMatch(/¿dónde meto X\?/);
    expect(prompt).toMatch(/LEE ese holding con `get_holding_detail`/);
    // The destination that was missing, with its field and its cadence (ADR 0076).
    expect(prompt).toMatch(/ficha del inmueble/i);
    expect(prompt).toMatch(/campo Gastos del cobro recurrente/i);
    expect(prompt).toMatch(/MISMA cadencia/);
    // The workaround it reached for once cornered, refused by name and for both
    // reasons — it corrupts the ledger AND it does not even fix the calc.
    expect(prompt).toMatch(/alquiler NETO en el campo Importe no vale/);
    expect(prompt).toMatch(/0054/);
    expect(prompt).toMatch(/0076/);
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
    //
    // #1524 raises it to 9300 for the capability asymmetry and the destination map.
    // It is the largest raise so far and the justification is the size of the failure:
    // a model told from memory, for three turns, that worthline does not register a
    // rental's expenses, defended it with an architecture that does not exist, and
    // sent a real user to a spreadsheet — with the field one `get_holding_detail`
    // away. There is no code boundary here at all: the whole event was prose, and
    // every tool involved already worked. What paid for part of it: the old bullet's
    // «si tus tools no soportan lo que el usuario pide, señala dónde SÍ se hace»
    // merged into this rule instead of sitting above it, the connected-source
    // bullet's «guía a la ruta de mapeo/fuente» dropped now that the map names the
    // route, and — per #1342's own ownership seam — what `get_holding_detail`
    // RETURNS (a holding's declared payouts, with their expenses) went into that
    // tool's description rather than being spelled out here.
    //
    // Note what this number is NOT paying for twice: the destinations themselves are
    // one string in `capability-destinations.ts`, read by this prompt and by the
    // maintainer alert's refusal message. Before #1524 that list lived only inside
    // the refusal, which is exactly why the rent entry was never added to it.
    //
    // #1563 did NOT raise it, and left it tight on purpose: the acquisition lane
    // needed one clause in the correction protocol, because that protocol still
    // routed «vivienda/apreciable» to the valuation anchor — the instruction that
    // produced #1437's failure (add one more tasación, leave the acquisition where
    // it was). It cost 70 of the 80 characters that were free, so the prompt now
    // sits at 9.290 with TEN to spare. The next rule that needs room raises the
    // number and writes down why, the way every raise above did; nothing here is
    // a reason to trim an existing instruction to make space.
    //
    // #1514 raises it to 9.680 for the structured-data counterweight, and the
    // justification is that the prompt was measurably ONE-SIDED: «hoja de cálculo»
    // appeared exactly once in these 9.290 characters and it was inside the
    // sentence that says «no». There was no positive rule at all for a turn that
    // DOES carry a document worthline validated — that half lived only in the tool
    // descriptions, which is #1342's seam and stays right — so a model reading the
    // whole prompt found one instruction about spreadsheets and it pointed at the
    // web door. On 2026-08-21 that is exactly what happened: the same DEGIRO
    // statement, `.xlsx` and `.pdf`, read identically by the deterministic route
    // (11 operations, 3 ISINs, `directionResolved: true`, the same `contextBlock`),
    // and only the `.xlsx` turn told a real user that «worthline no puede procesar
    // importaciones directas… a partir de un archivo Excel» and sent him to
    // /patrimonio > Importar extracto — to upload the file it had just read.
    //
    // No code boundary can close this one, and the shape is #1347's and #1418's:
    // every lane already worked, so the whole failure was prose. What the raise
    // buys is 337 characters of one bullet saying WHEN the chat lane applies (the
    // block is there, so the answer is here, «también si es una hoja de cálculo»)
    // plus 42 making the negative rule's trigger explicit — it fires on the BLOCK
    // «ADJUNTO NO ESTRUCTURADO», never on the file's extension, which is the
    // association the model actually made. Deliberately NOT bought: which tool to
    // reach for, which stays in the descriptions the model reads in the same
    // request. The prompt now sits at 9.669, with ELEVEN to spare.
    //
    // #1466 raises it to 9.840 for 160 characters, and the justification is that the
    // sentence being extended would otherwise become FALSE. The #1418 exception named
    // exactly one thing a user may type instead of upload — «el histórico de saldos de
    // una deuda» — and with the operation lane's second door open that closed list is
    // an instruction to refuse a dictated compra: the model reads one exception, sees
    // that a purchase is not in it, and asks for the justificante. That is the failure
    // of the issue, verbatim («worthline requiere este documento para validar y sellar
    // la transacción»), and it happened WITHOUT the tool ever being called — so it is
    // not reachable from the tool's description alone, which is #1342's seam and is
    // where the rest of this slice's characters went. What the raise buys is one
    // widened exception listing the two typed sources and the four terms an operation
    // needs; deliberately NOT bought: anything about how the parser reads them, which
    // is code. The prompt now sits at 9.829, with ELEVEN to spare.
    //
    // #1753 raises it to 10.320 for 480 characters, and both are prose failures no code
    // boundary reaches — the guard behind them worked, which is the point. Jose's turn
    // of 2026-09-01 got a refusal from `propose_operation` carrying the exact words that
    // unblocked him («no sé cuál es el importe: escríbeme sólo ése»), announced «he
    // preparado la propuesta» on top of it, and, off a name that matched a position with
    // a DIFFERENT ISIN, declared the two funds distinct and said it had gone ahead with
    // an alta nobody asked for. The ISIN in the ficha was the wrong one.
    //
    // 220 buy the first: a proposal lane that answers with an error prepared no card, so
    // the turn says what the error said and continues from there. It is #1130's honest
    // degradation applied to the write door — the prompt had that rule for an attachment
    // worthline could not read and none for a lane that says no — and it belongs here
    // rather than in a description because it spans all fifteen `propose_*`. Deliberately
    // NOT bought, the #1342 trade again: the catalogue of refusals, each of which already
    // answers with an actionable sentence when it fires.
    //
    // 260 buy the reciprocal of the identity rule this prompt already carries. That one
    // forbids «es otro producto» when the keys do not COMPARE (a symbol against an ISIN);
    // it says nothing about two ISINs that compare and differ, which reads as licence to
    // conclude «dos activos» — and the alta that follows splits one position in two. The
    // sentence names the other reading (the ficha may hold the wrong ISIN) and hands the
    // choice back. The prompt now sits at 10.309, with ELEVEN to spare.
    expect(buildChatSystemPrompt(null).length).toBeLessThanOrEqual(10_320);
  });

  /**
   * #1514: every attachment rule here is triggered by the NAME of the block the turn
   * carries, never by the file's extension — which only means anything while the two
   * sides say the same words. `attachment-chat.ts` builds each block out of these very
   * constants, so a rename that never reached the prompt fails HERE instead of leaving
   * the model reading a rule about a marker no turn carries. That silent state is the
   * same failure this ticket comes from: told about spreadsheets only in the sentence
   * that says «no», the model read the extension and bounced a validated document.
   */
  it("writes one rule per attachment block, named as the code emits it (#1514)", () => {
    const prompt = buildChatSystemPrompt(null);

    for (const blockName of Object.values(ATTACHMENT_BLOCK_NAMES)) {
      expect(prompt).toContain(`«${blockName}»`);
    }
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
