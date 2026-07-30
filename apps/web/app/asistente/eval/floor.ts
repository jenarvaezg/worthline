/**
 * Turn-floor meter (#1278). Prints what one assistant request costs before the
 * user types a word, attributed per tool, and — with `--live` — asks each
 * credential-backed provider what that same request costs in ITS tokens.
 *
 * The local half is deterministic (characters, see `turn-floor.ts`). The live
 * half is the only honest source of a token figure: it sends one minimal request
 * with the production system prompt and the production tool set, caps the answer
 * at one token, and reads `usage.inputTokens`. A provider that refuses the shape
 * outright is recorded too — the rejection carries the number it counted, which is
 * exactly the fact #1278 is about, and how the retired third entry was measured
 * while it was still in the pool.
 *
 * Usage (from the repo root):
 *   bun run eval:floor
 *   bun run eval:floor -- --live
 */

import { resolveProviderModel } from "@web/asistente/provider-model";
import {
  DEFAULT_PROVIDER_ALLOWLIST,
  type ProviderPoolEntry,
} from "@web/asistente/provider-pool";
import type { ScreenContext } from "@web/asistente/screen-context";
import { buildChatSystemPrompt } from "@web/asistente/system-prompt";
import { measureTurnFloor, turnFloorTools } from "@web/asistente/turn-floor";
import { generateText } from "ai";

/**
 * The three system prompts a real turn can carry: bare, with the screen context
 * block, and with the onboarding block — the widest of the three, and the one the
 * CI ceiling is set against.
 */
const VARIANTS: readonly { label: string; screenContext: ScreenContext | null }[] = [
  { label: "bare", screenContext: null },
  {
    label: "screenContext",
    screenContext: {
      route: "/patrimonio",
      section: "patrimonio",
      holdingId: null,
      view: {},
    },
  },
  {
    label: "onboarding",
    screenContext: { route: "/bienvenida", section: "otra", holdingId: null, view: {} },
  },
];

type LiveFloor =
  | { label: string; outcome: "measured"; inputTokens: number }
  | { label: string; outcome: "rejected"; rejection: string };

async function measureLiveFloor(entry: ProviderPoolEntry): Promise<LiveFloor | null> {
  const resolved = resolveProviderModel(entry);
  if (!resolved) return null;
  try {
    const result = await generateText({
      model: resolved.model,
      system: buildChatSystemPrompt(null),
      tools: turnFloorTools(),
      messages: [{ role: "user", content: "hola" }],
      // The answer is irrelevant: only what the request COSTS is measured, and a
      // one-token cap keeps the measurement itself off the daily allowance.
      maxOutputTokens: 1,
      maxRetries: 0,
    });
    const inputTokens = result.usage.inputTokens;
    return inputTokens === undefined
      ? { label: resolved.label, outcome: "rejected", rejection: "no usage reported" }
      : { label: resolved.label, outcome: "measured", inputTokens };
  } catch (error) {
    return {
      label: resolved.label,
      outcome: "rejected",
      rejection: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const tools = turnFloorTools();
  const floors = VARIANTS.map((variant) => ({
    label: variant.label,
    ...measureTurnFloor({
      system: buildChatSystemPrompt(variant.screenContext),
      tools,
    }),
  }));

  console.error(`${Object.keys(tools).length} tools · characters`);
  console.error("─".repeat(72));
  for (const floor of floors) {
    console.error(
      `${floor.label.padEnd(16)} system ${String(floor.systemChars).padStart(6)} · ` +
        `tools ${String(floor.toolChars).padStart(6)} · FLOOR ${String(floor.chars).padStart(6)}`,
    );
  }
  console.error("─".repeat(72));
  for (const tool of floors[0]?.tools ?? []) {
    console.error(
      `${String(tool.chars).padStart(6)}  ${tool.name.padEnd(34)} ` +
        `desc ${String(tool.descriptionChars).padStart(5)} · ` +
        `schema ${String(tool.schemaChars).padStart(5)}`,
    );
  }

  const liveFloors: LiveFloor[] = [];
  if (live) {
    console.error("─".repeat(72));
    for (const entry of DEFAULT_PROVIDER_ALLOWLIST) {
      const measured = await measureLiveFloor(entry);
      if (!measured) {
        console.error(`SKIP  ${entry.provider} · no credential`);
        continue;
      }
      liveFloors.push(measured);
      console.error(
        measured.outcome === "rejected"
          ? `ERR   ${measured.label} ${measured.rejection}`
          : `OK    ${measured.label} ${measured.inputTokens} input tokens`,
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      { measuredWith: "characters", floors, ...(live ? { liveFloors } : {}) },
      null,
      2,
    )}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(
    `Turn-floor meter failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
