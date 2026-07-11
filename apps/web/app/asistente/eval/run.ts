/**
 * Live assistant admission gate (#956). It evaluates one explicit provider/model
 * pair without changing production routing, paces multi-step turns to the
 * provider's free-tier limits, and emits one machine-readable report.
 *
 * Usage (from the repo root):
 *   bun run eval:assistant -- --provider google --model gemini-3.1-flash-lite
 */

import { writeFile } from "node:fs/promises";
import { chatAsOf } from "@web/asistente/chat-clock";
import { createChatTools } from "@web/asistente/chat-tools";
import { buildChatSystemPrompt } from "@web/asistente/system-prompt";
import { withStore } from "@web/store";
import type { StoreTarget } from "@web/store-resolver";
import { generateText, type LanguageModel, stepCountIs } from "ai";

import { type AdmissionQuestionResult, buildAdmissionReport } from "./admission";
import { createEvalModel } from "./candidate";
import {
  candidatePolicy,
  parseEvalArgs,
  shouldStopAfterProviderError,
} from "./candidate-config";
import { GOLDEN_QUESTIONS } from "./golden";
import type { AssistantAnswer } from "./graders";

const EVAL_NOW = process.env["WORTHLINE_DEMO_NOW"] || "2026-06-01T12:00:00.000Z";
const MAX_STEPS = 4;

function suggestedActions(result: {
  toolResults?: unknown[];
}): AssistantAnswer["quickActions"] {
  for (const raw of result.toolResults ?? []) {
    const toolResult = raw as { toolName?: string; output?: unknown; result?: unknown };
    if (toolResult.toolName !== "suggest_actions") continue;
    const output = (toolResult.output ?? toolResult.result) as
      | { actions?: unknown }
      | undefined;
    if (Array.isArray(output?.actions)) {
      return output.actions as AssistantAnswer["quickActions"];
    }
  }
  return [];
}

async function askAssistant(
  model: LanguageModel,
  persona: StoreTarget & { kind: "demo" },
  question: string,
): Promise<AssistantAnswer> {
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

  return {
    text: result.text,
    toolNames: (result.toolCalls ?? []).map((call) => call.toolName),
    quickActions: suggestedActions(result),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const args = parseEvalArgs(process.argv.slice(2));
  const policy = candidatePolicy(args.provider);
  const apiKey = process.env[policy.envKey];
  if (!apiKey) throw new Error(`${policy.envKey} is required for ${args.provider}.`);
  const model = createEvalModel(args.provider, args.model, apiKey);
  const startedAt = new Date().toISOString();

  console.error(
    `\nAssistant eval · ${args.provider} · ${args.model} · now=${EVAL_NOW.slice(0, 10)}`,
  );
  console.error("─".repeat(64));

  const questionResults: AdmissionQuestionResult[] = [];
  for (const [index, question] of GOLDEN_QUESTIONS.entries()) {
    if (index > 0) await sleep(policy.delayBetweenQuestionsMs);
    const target: StoreTarget & { kind: "demo" } = {
      kind: "demo",
      persona: question.persona,
      now: EVAL_NOW,
    };
    const rowLabel = `${question.persona}/${question.id}`.padEnd(36);

    try {
      const answer = await askAssistant(model, target, question.question);
      const checks = question.grade(answer);
      const passed = checks.filter((check) => check.pass).length;
      const green = passed === checks.length;
      questionResults.push({
        id: question.id,
        persona: question.persona,
        status: "completed",
        checks,
      });
      console.error(`${green ? "PASS" : "FAIL"}  ${rowLabel} ${passed}/${checks.length}`);
      for (const check of checks.filter((candidate) => !candidate.pass)) {
        console.error(`        ✗ ${check.name}`);
      }
    } catch (error) {
      const message = errorMessage(error);
      questionResults.push({
        id: question.id,
        persona: question.persona,
        status: "error",
        checks: question.grade({ text: "", toolNames: [], quickActions: [] }),
        error: message,
      });
      console.error(`ERR   ${rowLabel} ${message}`);
      if (shouldStopAfterProviderError(error)) break;
    }
  }

  const report = buildAdmissionReport({
    provider: args.provider,
    model: args.model,
    startedAt,
    finishedAt: new Date().toISOString(),
    expectedQuestionIds: GOLDEN_QUESTIONS.map((question) => question.id),
    questionResults,
    threshold: args.threshold,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(json);
  if (args.output) await writeFile(args.output, json, "utf8");

  console.error("─".repeat(64));
  console.error(
    `${report.summary.passed}/${report.summary.total} checks passed · ` +
      `${report.complete ? "complete" : "incomplete"} · ` +
      `${report.summary.admitted ? "ADMITTED" : "REJECTED"}\n`,
  );
  process.exitCode = report.summary.admitted ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`Assistant eval failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
