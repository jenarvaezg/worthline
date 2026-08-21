/**
 * The turn floor (#1278): what ONE assistant request costs before the user has
 * typed a word — the system prompt plus the name, description and JSON schema of
 * every tool the turn offers. It is the other half of the history ceiling
 * (#1260): that one bounds how much a conversation may GROW, this one measures
 * what every turn pays even when the conversation is empty.
 *
 * Why it needed a seam at all: the only figure anyone had was a sentence in a Groq
 * rejection — «Limit 12000, Requested 13017» on 2026-07-27, and 14.285 for the same
 * bare turn three days later, because the tool contract kept growing. One tokenizer's
 * opinion of one request, drifting, and saying nothing about WHERE the cost sits.
 * This attributes it per tool, so slimming can be aimed instead of guessed.
 *
 * Measured in characters on purpose. Each provider tokenizes with its own BPE, so
 * a token count computed here would be a fourth tokenizer's opinion — an estimate
 * dressed as a measurement. Characters are exact, deterministic and free, which
 * is what a CI tripwire needs; the token figure comes from the providers
 * themselves (`bun run eval:floor`, which reads `usage.inputTokens` off a real
 * minimal request, and records the rejection when one refuses the shape).
 */

import type { ToolSet } from "ai";

import { createChatTools } from "./chat-tools";

/**
 * The reviewed ceiling on the floor, held by this module's CI gate — and, since
 * #1408, the figure the per-model prompt budget charges before a word of the
 * conversation is counted. ONE number for both on purpose: the budget's whole
 * point is that what a turn PAYS and what a conversation may KEEP look at each
 * other, and two copies would let them drift apart silently.
 */
export const TURN_FLOOR_CHAR_CEILING = 42_400;

/** One tool's share of the floor: the three strings a provider receives for it. */
export interface TurnFloorTool {
  name: string;
  /** The prose the model reads to decide whether to call it. */
  descriptionChars: number;
  /** Its JSON Schema, serialized as the provider receives it. */
  schemaChars: number;
  /** `name` + description + schema — everything this tool adds to the floor. */
  chars: number;
}

export interface TurnFloorMeasurement {
  /** The system prompt, including any screen-context or onboarding block. */
  systemChars: number;
  /** Every tool together. */
  toolChars: number;
  /** The floor: system prompt + tools. */
  chars: number;
  /** Per tool, most expensive first — the ranking slimming works down. */
  tools: readonly TurnFloorTool[];
}

/**
 * The JSON Schema a tool puts on the wire. The AI SDK's `jsonSchema()` wraps the
 * schema next to its validator, so the wrapper is unwrapped rather than
 * serialized: `{"jsonSchema":…,"validate":undefined}` would measure the wrapper,
 * not the payload.
 */
function toolSchemaChars(inputSchema: unknown): number {
  const schema =
    inputSchema !== null && typeof inputSchema === "object" && "jsonSchema" in inputSchema
      ? (inputSchema as { jsonSchema: unknown }).jsonSchema
      : inputSchema;
  return JSON.stringify(schema ?? null).length;
}

/**
 * The tool set of an ordinary turn — no paywall, no unvalidated evidence — built
 * through the route's own factory. ONE builder for the meter and for the CI gate on
 * purpose: two copies would drift, and then the number the gate holds would not be
 * the number the meter prints. Nothing here is executed (a floor is what the request
 * carries, not what a tool answers), so the store closure is never reached.
 */
export function turnFloorTools(): ToolSet {
  return createChatTools({
    runWithStore: () =>
      Promise.reject(new Error("The turn-floor meter never executes a tool.")),
    asOf: "2026-01-01",
  });
}

/**
 * Measure the floor of a turn built from this system prompt and this tool set.
 * Pure: no provider, no network, same answer every run.
 */
export function measureTurnFloor(input: {
  system: string;
  tools: ToolSet;
}): TurnFloorMeasurement {
  const tools = Object.entries(input.tools)
    .map(([name, tool]) => {
      const descriptionChars = (tool.description ?? "").length;
      const schemaChars = toolSchemaChars(
        (tool as { inputSchema?: unknown }).inputSchema,
      );
      return {
        name,
        descriptionChars,
        schemaChars,
        chars: name.length + descriptionChars + schemaChars,
      };
    })
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));

  const toolChars = tools.reduce((total, tool) => total + tool.chars, 0);
  return {
    systemChars: input.system.length,
    toolChars,
    chars: input.system.length + toolChars,
    tools,
  };
}
