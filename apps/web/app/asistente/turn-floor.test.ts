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
