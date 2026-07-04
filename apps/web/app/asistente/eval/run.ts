/**
 * Assistant eval harness (#668, S6) — the golden-question run against the REAL
 * provider. CI's fake streams prove the plumbing; only this tells us whether the
 * shared cheap baseline actually READS tool outputs correctly (net worth vs
 * liquid, market move vs contribution, honest missing-fact). It exercises the
 * exact same seam as the chat route: same model resolution, same tools over the
 * demo personas' agent-view read store, same system prompt.
 *
 * Deliberately OUTSIDE the CI test gate (it costs real tokens and needs a live
 * key). It is the PRE-SWAP GATE: rerun it before changing the baseline
 * model/provider through the gateway — the gateway makes a swap a mere config
 * change, which is exactly why it must not be blind.
 *
 * Usage:
 *   npm run eval:assistant                         # from repo root
 *   WORTHLINE_CHAT_MODEL=groq/other npm run eval:assistant   # compare a candidate
 */
import { generateText, stepCountIs } from "ai";

import { chatAsOf } from "@web/asistente/chat-clock";
import { chatModelLabel, resolveChatModel } from "@web/asistente/chat-model";
import { createChatTools } from "@web/asistente/chat-tools";
import { buildChatSystemPrompt } from "@web/asistente/system-prompt";
import { withStore } from "@web/store";
import type { StoreTarget } from "@web/store-resolver";

import { GOLDEN_QUESTIONS } from "./golden";
import type { AssistantAnswer } from "./graders";

// Pin the demo clock so the seeded dataset — and thus the expected answers — is
// deterministic run to run. Overridable to probe a different point in time.
const EVAL_NOW = process.env["WORTHLINE_DEMO_NOW"] || "2026-06-01T12:00:00.000Z";
const MAX_STEPS = 4;

/** Pull the already-validated quick actions out of the suggest_actions result. */
function suggestedActions(result: {
  toolResults?: unknown[];
}): AssistantAnswer["quickActions"] {
  for (const raw of result.toolResults ?? []) {
    const r = raw as { toolName?: string; output?: unknown; result?: unknown };
    if (r.toolName !== "suggest_actions") continue;
    const out = (r.output ?? r.result) as { actions?: unknown } | undefined;
    if (Array.isArray(out?.actions))
      return out.actions as AssistantAnswer["quickActions"];
  }
  return [];
}

async function askAssistant(persona: StoreTarget & { kind: "demo" }, question: string) {
  const model = resolveChatModel();
  if (model === null) throw new Error("no model");

  const result = await generateText({
    model,
    system: buildChatSystemPrompt(null),
    prompt: question,
    tools: createChatTools({
      runWithStore: (run) =>
        withStore((store) => run({ agentView: store.agentView }), persona),
      asOf: chatAsOf(persona),
    }),
    stopWhen: stepCountIs(MAX_STEPS),
  });

  const answer: AssistantAnswer = {
    text: result.text,
    toolNames: (result.toolCalls ?? []).map((c) => c.toolName),
    quickActions: suggestedActions(result),
  };
  return answer;
}

async function main(): Promise<void> {
  const label = chatModelLabel();
  if (resolveChatModel() === null || label === null) {
    console.log(
      "\n⏭  Eval skipped: no provider key configured.\n" +
        "   Set GROQ_API_KEY (or AI_GATEWAY_API_KEY) to run the golden set.\n",
    );
    return;
  }

  console.log(`\nAssistant eval · ${label} · now=${EVAL_NOW.slice(0, 10)}`);
  console.log("─".repeat(64));

  let totalChecks = 0;
  let totalPass = 0;
  let questionsGreen = 0;

  for (const q of GOLDEN_QUESTIONS) {
    const target: StoreTarget & { kind: "demo" } = {
      kind: "demo",
      persona: q.persona,
      now: EVAL_NOW,
    };
    const rowLabel = `${q.persona}/${q.id}`.padEnd(36);

    try {
      const answer = await askAssistant(target, q.question);
      const checks = q.grade(answer);
      const passed = checks.filter((c) => c.pass).length;
      totalChecks += checks.length;
      totalPass += passed;
      const green = passed === checks.length;
      if (green) questionsGreen += 1;

      console.log(`${green ? "PASS" : "FAIL"}  ${rowLabel} ${passed}/${checks.length}`);
      for (const c of checks.filter((c) => !c.pass)) {
        console.log(`        ✗ ${c.name}`);
      }
    } catch (error) {
      console.log(`ERR   ${rowLabel} ${(error as Error).message}`);
    }
  }

  console.log("─".repeat(64));
  console.log(
    `${totalPass}/${totalChecks} checks passed · ` +
      `${questionsGreen}/${GOLDEN_QUESTIONS.length} questions fully green\n`,
  );
}

void main();
