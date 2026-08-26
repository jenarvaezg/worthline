import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";

import { buildChatSystemPrompt } from "./system-prompt";
import { measureTurnFloor, TURN_FLOOR_CHAR_CEILING, turnFloorTools } from "./turn-floor";

/**
 * The floor the pool's providers actually charged for, measured with
 * `bun run eval:floor -- --live`.
 *
 * On 2026-07-30, against a bare turn of 35.390 characters:
 *
 *   google   · gemini-3.1-flash-lite   9.231 input tokens
 *   cerebras · gpt-oss-120b            7.732 input tokens
 *   groq     · llama-3.3-70b-versatile REJECTED — «Limit 12000, Requested 14285»
 *
 * That last line is why Groq left the pool (#1278) and why this ceiling exists:
 * three tokenizers read the same request as 7.700 to 14.300 tokens, so the only
 * number a test can hold honestly is the character count they all tokenize. (The
 * Groq line is dated evidence, not a reproducible command: the provider is out of
 * the allowlist, so `--live` no longer offers it a request.)
 *
 * On 2026-08-03, after #1342 slimmed the floor to 32.719 characters, the same
 * measurement:
 *
 *   google   · gemini-3.1-flash-lite   8.540 input tokens
 *   cerebras · gpt-oss-120b            7.031 input tokens
 *
 * Read those two pairs against each other and they vindicate the choice of unit:
 * between the two floors that were BOTH measured live, 35.390 and 32.719 characters
 * (−7,55%), Gemini charged −7,49% and Cerebras −9,07%. Tokens track characters at
 * roughly one to one, so the cheap deterministic meter is a faithful proxy for the
 * bill — which is exactly what `turn-floor.ts` assumes and had never been checked.
 * (The floor this slice actually started from was 37.024 characters, −11,63% to
 * here; no live figure exists for it, so it is not part of that comparison.)
 *
 * The ceiling was set against the WIDEST real floor — the onboarding turn, 34.660
 * characters — plus about 7%: room to sharpen a description or two, not room for a
 * new tool family to arrive unnoticed (the average tool costs 722). Raising it is a
 * decision, and it belongs in the PR that raises it.
 *
 * That headroom is now 2,9%, not 7%: the widest floor measured 35.923 characters on
 * 2026-08-04 (#1346 spent 895 on the row identity of an import, #1347 another 368
 * on the maintainer alert's admission boundary). Read the ceiling as one tool
 * family away, not as room — the arithmetic that justified it has moved.
 *
 * 36.353 on 2026-08-05 (#1349): 1,75% of headroom left. The identity fill spent 430
 * — 370 on `propose_correction`'s description and 60 on its two new schema fields —
 * and paid 23 back on the prompt, whose absolute «el precio/símbolo NO es un hecho
 * editable» became the narrower rule that is still true. It is deliberately the
 * tool's description and not the prompt: every rule the fill needs is about ONE
 * tool, so the prompt keeps only the half that routes an overwrite to the ficha.
 *
 * **Raised to 38.800 on 2026-08-05 by #1374**, the case the ceiling was written for:
 * «a new tool family arriving» — arriving in a PR that says so. `propose_operation`
 * is the lane «añádeme esta compra» never had, and it costs 1.488 characters (desc
 * 1.052 · schema 419), which takes the widest real floor to 38.214. It is mid-pack:
 * cheaper than `propose_reconcile` (1.979) or `propose_early_repayment` (1.633), and
 * its three sentences are three separate acceptance criteria of the issue — the
 * document-only frontier, the units contract, and the routing away from the batch
 * lanes. Nothing in it restates a sibling's rule.
 *
 * What it deliberately does NOT carry is the app's catalogue of refusals (divisa,
 * ISIN contradictorio, duplicado, sobreventa, fecha futura): the floor is paid on
 * EVERY turn and a rejection only when it fires, and each one answers with an
 * actionable message. That is the same trade #1342 made, applied to a new tool
 * instead of retrofitted onto an old one, and it is worth 152 characters.
 *
 * So headroom is 1,5%, and the honest reading has not changed since #1349: this IS the
 * slimming slice's cue. `propose_holding` alone is 2.543 (desc 1.738) and
 * `propose_correction` 2.127 — between them a fifth of the tool half. The next slice
 * that needs characters here should spend them there, not on another raise.
 *
 * The number itself moved next to the meter (`TURN_FLOOR_CHAR_CEILING`) when #1408
 * made the per-model prompt budget charge it: the budget subtracts what a turn pays
 * before dividing what is left, so a second copy of the figure here would let the
 * two drift. This file keeps the evidence; the module keeps the value.
 *
 * **Raised to 40.300 on 2026-08-17 by #1423**, the second «new tool family» raise and
 * for the same kind of reason as #1374: `propose_reconstruction_amendment` is the lane
 * «quita los puntos estimados» never had. Without it the only way to change a
 * reconstruction already on screen was to RE-EMIT its 49 rows, which is precisely the
 * payload `gemini-3.1-flash-lite` stops producing — a real user got «he actualizado la
 * propuesta» over a proposal nothing had touched. So the raise buys a cheaper turn,
 * not a more expensive one: the amendment is a two-field call where the alternative
 * was a 49-row array, and the alternative did not work.
 *
 * The arithmetic: the widest real floor is 39.708 (1.235 for the tool — desc 730 ·
 * schema 473 — plus 158 on `propose_reconstruction`'s pointer to it), and the ceiling
 * keeps the same ~1,5% headroom #1374 left. The tool is mid-pack and it paid what it
 * could inside its own lane first: its description started at 1.106 and lost 376 (the
 * «no reemitas» sentence, which the sister tool's pointer already carries, and two of
 * three examples). What it did NOT do is slim a sibling — `propose_holding` (2.543)
 * and `propose_correction` (2.127) are still the ranking's head, and their length is
 * measured incident repair, not padding: trimming them blind from this lane would be
 * trading a floor for a behaviour nobody re-measured. That slice is still owed, and it
 * is still the honest reading of this list.
 *
 * The prompt paid nothing: «enmienda en vez de reemitir» is a choice between two
 * sibling tools, so it lives in their descriptions (see `system-prompt.ts`).
 *
 * **NOT raised by #1487**, and that is the point worth recording. The broker
 * transactions lane needed the model to know one thing it could not guess — that with a
 * `broker_transactions` document on the table the call takes NO arguments — and the
 * first draft of that sentence put the onboarding floor 145 characters over the ceiling.
 * It was paid inside its own lane instead: the same two facts said shorter, plus 27
 * characters recovered from `propose_statement_import`'s own older sentences («se
 * persisten solo los movimientos extraídos…», «el proposalId devuelto antes») with their
 * meaning intact, and the `required: ["rawText"]` the schema no longer has. The ranking's
 * head is still `propose_holding` (2.543) and `propose_correction` (2.127), and the
 * slimming slice they are owed is still owed.
 *
 * **NOT raised by #1488 either**, and this one had 8 characters to work with. The
 * statement gate learned a second format (a broker's transactions export) and the
 * prompt, which named that door without ever saying what it reads, had to start saying
 * it — the silence a model filled by telling a user his DEGIRO file would reconcile
 * there. The clause interpolates `STATEMENT_GATE_FORMATS`
 * rather than restating it, so the prompt cannot drift from what the reader accepts, and
 * it was paid inside the same rule: its own sentences said shorter with their
 * instructions intact, and «xlsx o csv» dropped from the format's wording — the page's
 * file input already lists the extensions, and the model never picks one. The onboarding
 * floor moved 40.292 → 40.297, 3 characters of headroom left.
 *
 * TWO of the first rewordings were wrong, and `system-prompt.test.ts` caught both — which
 * is what that test is for. «pregunta y no propongas, y si dudas de la cifra, no
 * propongas» shortened to «pregunta; …» drops the instruction for the ambiguity it names
 * FIRST (which holding); «reconstrucción de histórico» shortened to «reconstrucción»
 * drops what a reconstruction is OF, and the prompt distinguishes it from a bulk import
 * two clauses later. Both were restored and the characters found elsewhere. Slimming is
 * rewording; a clause that carries an instruction is not spare.
 *
 * The rest of the ticket's copy costs the floor NOTHING, deliberately: the four routing
 * envelopes that name the door are app text and tool results, not the turn's floor, so
 * the full list lives there at no charge (`statement-gate-promises.test.ts` holds them to
 * it). What the prompt carries is the one thing an envelope cannot: the boundary, before
 * anybody has refused anything.
 *
 * **Raised to 41.450 on 2026-08-19 by #1489**, and not the raise this file keeps telling
 * the next slice to avoid. That instruction — spend from `propose_holding` /
 * `propose_correction`, do not raise — is written for a slice that wants characters for a
 * NEW capability. This one repairs a measured incident: over six buys of `IE00B52MJY50`
 * the assistant read the user's own position, saw `SXR1.DE`, and told him his statement
 * held a DIFFERENT product. It does not. The failure sends a real user to duplicate a
 * position he already owns, and no code can refuse a sentence — so the rule has to be in
 * the prompt, where an identity claim that spans two tools belongs (#1342's split).
 *
 * The arithmetic: the widest real floor is 40.864, up 567 from the 40.297 the note above
 * leaves — a floor with THREE characters of headroom under the old 40.300 ceiling, which
 * is why any addition at all had to come here. 460 of those 567 are the prompt rule, 99
 * the clause that tells the model an ISIN query comes back paired with its symbol, and 8
 * the `isin` in the candidate fields it now returns. The new ceiling keeps ~1,4% of
 * headroom, the same order the #1374 and #1423 raises left.
 *
 * It paid inside its own lane twice before asking. The first draft of the tool sentence
 * was 430 characters (the pairing, the asymmetry, and why it matters); the second 200;
 * what shipped is 99, because the prompt rule already names the tool AND the direction
 * («resuelve el ISIN del documento»), so a second copy of the direction in the tool was
 * the kind of duplication #1342 removed. The prompt bullet itself went 610 → 460.
 *
 * What it did NOT do is trim `propose_holding` or `propose_correction` blind, for the
 * reason #1423 wrote down: their length is measured incident repair, and cutting it from
 * an unrelated lane trades a floor for a behaviour nobody re-measured. That slice is
 * still owed, and it is now the third PR in a row to say so.
 *
 * **Raised to 42.400 on 2026-08-21 by #1524**, and it is the #1489 kind of raise again:
 * a measured incident that no boundary in code can close. Asked «¿dónde introduzco los
 * gastos declarados en las viviendas alquiladas?», the assistant answered from memory —
 * no read at all — that worthline does not register them, held that for three turns,
 * defended it with an architecture that does not exist («no tiene un libro de
 * contabilidad de ingresos/gastos»), and sent a real user to a spreadsheet. The field
 * has existed since #1448 and sat one `get_holding_detail` away. Nothing in code can
 * refuse a sentence about what the product IS, and every tool involved already worked.
 *
 * The arithmetic: the widest real floor is 41.902, up 1.038 from #1489's 40.864. The
 * prompt carries most of it — the capability asymmetry plus the destination map, which
 * the maintainer alert's refusal message now reads from the same module so the two
 * cannot drift (`capability-destinations.ts`) — and 198 are `get_holding_detail` saying
 * what it returns: a holding's declared payouts and their `expenses`, `null` when nobody
 * declared any. The ceiling keeps ~1,19% of headroom, the same order as #1374, #1423
 * and #1489.
 *
 * It paid inside its own lane before asking, and the payment is exactly the #1342 split:
 * the first draft said ADR 0076's rule TWICE — «sin gastos declarados el motor descarta
 * ese alquiler» in the prompt's banned-workaround clause and again in the tool that
 * returns the field. The tool keeps it, because that is where the model reads
 * `expenses`; the prompt's clause now only names the workaround as refused. 185
 * characters, and one fewer place for the rule to drift.
 *
 * What it did NOT keep is a saving it had banked by DELETING guidance: the first draft
 * paid 31 characters by dropping «Guía a la ruta de mapeo/fuente.» from the
 * connected-source bullet, on the theory that the destination map's `/ajustes/conexiones`
 * replaced it. It does not — the map names the surface, the bullet names the ROUTE, and
 * a price that smells of sync is a mapping question before it is a conexiones one. The
 * sentence is back and the 31 characters are paid from the ceiling instead. A raise buys
 * room for a new rule; it must not quietly buy the removal of an old one.
 *
 * `propose_holding` (2.543) and `propose_correction` (2.127) are still the ranking's
 * head and were still not touched, for the reason #1423 gave. Fourth PR in a row.
 *
 * **Raised to 43.850 on 2026-08-21 by #1482**, and this is the #1374/#1423 kind: a new
 * tool family arriving, in the PR that says so. `propose_transfer` is the lane «he
 * traspasado 1.018,67 € del fondo A al fondo B» never had, and without it the model has
 * exactly one way to record what the user just told it — a venta plus a compra, which
 * realizes a plusvalía that never happened and eats a year of cupo de aportación (ADR
 * 0080). So the raise buys the write that is CORRECT, not an extra one.
 *
 * The arithmetic: the widest real floor is 43.314, of which 1.062 is this lane — the
 * tool costs 975 (desc 739 · schema 236, the cheapest of the eleven `propose_*`) plus 87
 * for the pointer added to `propose_operation`, «un traspaso entre dos inversiones →
 * propose_transfer (no es una venta más una compra)», which is the sibling-tools rule of
 * #1423 and the sentence that stops the wrong write. The floor this PR started from was
 * therefore 42.252: 148 characters of headroom under the old ceiling, so any addition at
 * all had to come here. (#1524's note above recorded 41.902; the 350 between them arrived
 * in slices merged since, none of which touched this ceiling.) The new ceiling keeps
 * ~1,2% of headroom, the same order as every raise since #1374.
 *
 * It paid inside its own lane first, 369 characters, and each cut is the #1342 trade
 * rather than a shortening:
 *  - the three consequences of the instrument (no realiza plusvalía · el coste viaja ·
 *    no consume cupo) came out of the description because the CARD prints them
 *    (`TRANSFER_NEUTRALITY_NOTE`): the floor is paid on every turn, card copy when there
 *    is a card. What stays is the half that ROUTES — «no una venta más una compra».
 *  - «con identificadores que te haya devuelto una lectura» came out because the prompt
 *    already carries it for every tool (#1263). One copy, not twelve.
 *  - «no los pases, no los deduzcas, no los repitas de un turno anterior» came out
 *    because the schema has no such fields and `additionalProperties: false`: a sentence
 *    forbidding what the shape cannot express defends nothing.
 *  - the `propose_correction` pointer came out; the two that matter for a traspaso (the
 *    destination that does not exist yet, and the buy/sell it is not) stayed.
 *
 * The IMPORTE and the DATE are not in the schema at all, and that absence is worth
 * naming here because it is what makes this the cheapest lane: worthline parses them off
 * the user's own message (`typed-transfer.ts`), so there is no field for them and no
 * prose explaining how to fill it — ADR 0067's rule («a mandatory field a real document
 * cannot fill is an instruction to invent») paying for itself in characters for once.
 *
 * `propose_holding` is now 2.893 — it grew 350 since #1524 and is still the ranking's
 * head, with `propose_correction` (2.127) behind it. Not touched, for the reason #1423
 * gave: their length is measured incident repair, and cutting it blind from an unrelated
 * lane trades a floor for a behaviour nobody re-measured. Fifth PR in a row to say so,
 * and the first where the head GREW while saying it.
 *
 * **Raised to 45.200 on 2026-08-26 by #1563**, the #1482 kind again: a new lane arriving,
 * in the PR that says so. `propose_property_acquisition` moves the anchor that decides
 * from WHEN a property exists in the history, and without it the assistant's only way to
 * act on «lo compré en 2004 por 150.253 €» is `propose_property_valuation_anchor`, which
 * adds one more tasación and leaves the acquisition where it was — the failure of #1437,
 * where a flat bought in 2004 read as bought the day it was typed and 266 snapshots lost
 * the mortgage it secures. So the raise buys the write that is CORRECT, not an extra one.
 *
 * The arithmetic: the widest real floor is 44.643, of which 809 is this lane (desc 548 ·
 * schema 233), leaving the floor this PR started from at 43.834 — SIXTEEN characters of
 * headroom under the old ceiling, so a lane of any size at all had to come here. The new
 * ceiling keeps ~1,2% of headroom, the same order as every raise since #1374.
 *
 * It paid inside its own lane first, 438 characters, and each cut is the #1342 trade:
 *  - the provenance of the figures («te los dice, o los lees de una escritura, una nota o
 *    su propio Excel») came out: WHERE evidence may come from is the frontier's job and
 *    it is code (`unvalidated-evidence-gate.ts`), not a sentence in a description.
 *  - what the preview shows — the antes → después of the two figures, and which tramo of
 *    the history the rewrite reaches — came out because the CARD prints it, exactly as
 *    #1482's neutrality note did. The floor is paid every turn; card copy only when
 *    there is a card.
 *  - the three refusals (no acquisition anchor, a proposal that changes nothing, a date
 *    another valoración occupies) came out: the model reads each one as a message when it
 *    happens, and a description listing them pays for them on every turn instead.
 *  - `summary` is not in the schema at all: the card's headline is built from the
 *    property's own name, date and price, so the one field a prompt injection would want
 *    (`proposal-summary.ts`) does not exist here — and the schema is 233 characters, the
 *    slimmest of the fifteen `propose_*`.
 *
 * `propose_holding` (2.893) and `propose_correction` (2.127) are still the ranking's head
 * and still untouched, for the reason #1423 gave. Sixth PR in a row to say so.
 */

describe("measureTurnFloor", () => {
  it("attributes the floor to the system prompt and to each tool", () => {
    const measurement = measureTurnFloor({
      system: "0123456789",
      tools: {
        ab: tool({
          description: "four",
          inputSchema: jsonSchema<Record<string, never>>({ type: "object" }),
        }),
      },
    });

    // `{"type":"object"}` is 17 characters, plus «four» and the two-letter name.
    expect(measurement).toEqual({
      systemChars: 10,
      toolChars: 23,
      chars: 33,
      tools: [{ name: "ab", descriptionChars: 4, schemaChars: 17, chars: 23 }],
    });
  });

  it("ranks the tools by what they cost, most expensive first", () => {
    const emptySchema = jsonSchema<Record<string, never>>({ type: "object" });
    const measurement = measureTurnFloor({
      system: "",
      tools: {
        cheap: tool({ description: "x", inputSchema: emptySchema }),
        dear: tool({ description: "x".repeat(50), inputSchema: emptySchema }),
      },
    });

    expect(measurement.tools.map((entry) => entry.name)).toEqual(["dear", "cheap"]);
  });

  it("measures the schema a provider receives, not the SDK wrapper around it", () => {
    // `jsonSchema()` hands back `{ jsonSchema, validate }`. Serializing that wrapper
    // would measure a constant and miss every schema change underneath it.
    const measurement = measureTurnFloor({
      system: "",
      tools: {
        t: tool({
          description: "",
          inputSchema: jsonSchema<{ a?: string }>({
            type: "object",
            properties: { a: { type: "string" } },
          }),
        }),
      },
    });

    expect(measurement.tools[0]?.schemaChars).toBe(
      JSON.stringify({ type: "object", properties: { a: { type: "string" } } }).length,
    );
  });
});

describe("the production turn floor", () => {
  it("stays under the reviewed ceiling", () => {
    const floor = measureTurnFloor({
      system: buildChatSystemPrompt(null),
      tools: turnFloorTools(),
    });

    expect(floor.chars).toBeLessThanOrEqual(TURN_FLOOR_CHAR_CEILING);
  });

  it("counts the onboarding turn too, which is the widest system prompt", () => {
    // Onboarding adds a block to the same prompt (#1169/#1170), so it is the worst
    // case a real turn can reach — and it is charged before the user has spoken.
    const onboarding = measureTurnFloor({
      system: buildChatSystemPrompt({
        route: "/bienvenida",
        section: "otra",
        holdingId: null,
        view: {},
      }),
      tools: turnFloorTools(),
    });

    expect(onboarding.chars).toBeLessThanOrEqual(TURN_FLOOR_CHAR_CEILING);
  });

  /**
   * The two sentences #1342 stopped paying for once per tool.
   *
   * Both are cross-cutting rules with a boundary in CODE behind them, and both used
   * to be restated in the descriptions — the connected-source frontier in five of
   * them, «this id came out of a read» in seven. That is how the floor grew 1.634
   * characters in the four days between #1278's measurement and this slice: every
   * write tool added carried the boilerplate of its siblings.
   *
   * These are prose tripwires, so they catch the regrowth of THESE two sentences and
   * not every possible duplication. That is the point: they are the two that were
   * measured, and a description that needs to say either one is a description whose
   * author should read why the rule lives where it lives (see `chat-tools.ts`).
   */
  describe("a cross-cutting rule is paid once, not once per tool (#1342)", () => {
    // The SDK types `description` as string OR a context-dependent builder; every
    // chat tool writes a literal, and a builder would be measured wrong by the meter
    // too, so a non-string here is a finding rather than a case to handle.
    const toolDescriptions = (): readonly (readonly [string, string])[] =>
      Object.entries(turnFloorTools()).map(([name, tool]) => {
        expect(typeof tool.description, name).toBe("string");
        return [name, String(tool.description)] as const;
      });

    const namesWhoseDescriptionMatches = (pattern: RegExp): string[] =>
      toolDescriptions()
        .filter(([, description]) => pattern.test(description))
        .map(([name]) => name);

    it("leaves the connected-source frontier to the prompt and to the guard", () => {
      // One sentence in `buildChatSystemPrompt`, and a typed rejection in
      // `connected-source-write-guard.ts` that a description never enforced.
      expect(namesWhoseDescriptionMatches(/Binance|Numista/)).toEqual([]);
      expect(buildChatSystemPrompt(null)).toMatch(/Binance/);
    });

    it("leaves id provenance to the prompt and to the guard", () => {
      // `holding-id-provenance.ts` refuses an id no read ever surfaced, so a tool
      // repeating «es el public id de las tools de lectura» bought nothing. Naming
      // the `wl_hld_…` SHAPE in a read's own description is a different thing and
      // stays: that is the argument it takes.
      expect(
        namesWhoseDescriptionMatches(/de las tools de lectura|obtenido de las tools/i),
      ).toEqual([]);
      expect(buildChatSystemPrompt(null)).toMatch(
        /un id solo puede venir de una lectura/i,
      );
    });
  });

  it("keeps the tool contract as the dominant half of the floor", () => {
    // Where slimming has to aim: the 35 tools' descriptions and schemas outweigh the
    // whole system prompt more than three to one, and #1342 did not change that —
    // it cut both halves. Inside the tool half, descriptions are still the majority
    // (14.462 characters against 10.127 of JSON Schema), but what is left in them is
    // per-tool argument semantics rather than duplication, and the schema IS the
    // contract. A change that inverts this ratio is a change in the shape of the
    // problem, and should be read as one.
    const floor = measureTurnFloor({
      system: buildChatSystemPrompt(null),
      tools: turnFloorTools(),
    });

    expect(floor.toolChars).toBeGreaterThan(floor.systemChars);
  });
});
