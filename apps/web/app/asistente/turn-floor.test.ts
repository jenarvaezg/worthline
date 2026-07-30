import { jsonSchema, tool } from "ai";
import { describe, expect, it } from "vitest";

import { buildChatSystemPrompt } from "./system-prompt";
import { measureTurnFloor, turnFloorTools } from "./turn-floor";

/**
 * The floor the pool's providers actually charged for on 2026-07-30, measured with
 * `bun run eval:floor -- --live` against a bare turn of 35.390 characters:
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
 * The ceiling is set against the WIDEST real floor — the onboarding turn, 37.331
 * characters — plus about 7%: room to sharpen a description or two, not room for a
 * new tool family to arrive unnoticed (the average tool costs 775). Raising it is a
 * decision, and it belongs in the PR that raises it.
 */
const TURN_FLOOR_CHAR_CEILING = 40_000;

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

  it("keeps the tool contract as the dominant half of the floor", () => {
    // Where slimming has to aim if it ever happens: 34 tool descriptions and schemas
    // outweigh the whole system prompt roughly three to one. A change that inverts
    // this is a change in the shape of the problem, and should be read as one.
    const floor = measureTurnFloor({
      system: buildChatSystemPrompt(null),
      tools: turnFloorTools(),
    });

    expect(floor.toolChars).toBeGreaterThan(floor.systemChars);
  });
});
