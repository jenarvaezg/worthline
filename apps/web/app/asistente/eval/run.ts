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
import { chatToolStores, createChatTools } from "@web/asistente/chat-tools";
import { resolveProviderModel } from "@web/asistente/provider-model";
import { buildChatSystemPrompt } from "@web/asistente/system-prompt";
import { withStore } from "@web/store";
import type { StoreTarget } from "@web/store-resolver";
import { generateText, type LanguageModel, stepCountIs } from "ai";

import { type AdmissionQuestionResult, buildAdmissionReport } from "./admission";
import {
  candidatePolicy,
  parseEvalArgs,
  shouldStopAfterProviderError,
} from "./candidate-config";
import { type Check, GOLDEN_QUESTIONS, type GoldenQuestion } from "./golden";
import { type EvalCandidate, prepareGoldenTurn } from "./golden-turn";
import type { AssistantAnswer } from "./graders";

const EVAL_NOW = process.env["WORTHLINE_DEMO_NOW"] || "2026-06-01T12:00:00.000Z";
const MAX_STEPS = 6;

function suggestedActions(
  results: AssistantAnswer["toolResults"],
): AssistantAnswer["quickActions"] {
  for (const toolResult of results) {
    if (toolResult.name !== "suggest_actions") continue;
    const output = toolResult.output as { actions?: unknown } | undefined;
    if (Array.isArray(output?.actions)) {
      return output.actions as AssistantAnswer["quickActions"];
    }
  }
  return [];
}

async function askAssistant(
  model: LanguageModel,
  persona: StoreTarget & { kind: "demo" },
  question: GoldenQuestion,
  candidate: EvalCandidate,
): Promise<AssistantAnswer> {
  // Documents read through the production seams, asserted against what the question
  // declares, and composed into one turn — all in a single call on purpose (#1376):
  // the two bugs this harness has had were both a caller forwarding some of what a
  // document turn carries and not the rest, and each one graded the hole as a model
  // defect (#1265, #1373).
  const asOf = chatAsOf(persona);
  const turn = await prepareGoldenTurn(question, candidate, asOf);
  const result = await generateText({
    model,
    system: buildChatSystemPrompt(null),
    messages: turn.messages,
    tools: createChatTools({
      // The chat route's own slice, not a copy of it (#1265): the harness used to
      // forward three of six, which left every proposal tool answering
      // `proposal_persistence_unavailable` — the write path could not be measured,
      // because what came back was the harness's hole rather than the model.
      runWithStore: (run) => withStore((store) => run(chatToolStores(store)), persona),
      asOf,
      typedBalanceSeries: turn.typedBalanceSeries,
      unvalidatedEvidence: turn.unvalidatedEvidence,
      validatedDocuments: turn.validatedDocuments,
    }),
    stopWhen: stepCountIs(MAX_STEPS),
  });

  // Typed straight off the SDK result — `toolCalls` and `toolResults` already span
  // every step of the turn, which is what makes an id's provenance gradeable: the
  // read happens in one step and the proposal in another.
  const results = result.toolResults.map((toolResult) => ({
    name: toolResult.toolName,
    output: toolResult.output,
  }));
  return {
    text: result.text,
    toolCalls: result.toolCalls.map((call) => ({
      input: call.input,
      name: call.toolName,
    })),
    toolResults: results,
    quickActions: suggestedActions(results),
  };
}

const EMPTY_ANSWER: AssistantAnswer = {
  text: "",
  toolCalls: [],
  toolResults: [],
  quickActions: [],
};

/**
 * A question the provider never answered scores zero — every check failed, keeping
 * the rule the README states («their question checks count as failed»).
 *
 * Grading the empty answer would not do it any more. Three of the five write-path
 * checks are ABSTENTIONS — «no propone sin resolver de qué holding habla», «no
 * finge una propuesta» — and silence satisfies all three, so a question killed by a
 * provider quota would score 3/5 IN THE MODEL'S FAVOUR on the dimension that
 * decides whether it can be trusted to write. The check names are kept so the
 * report still shows what went unmeasured.
 */
function failedChecks(question: GoldenQuestion): Check[] {
  return question.grade(EMPTY_ANSWER).map((check) => ({ name: check.name, pass: false }));
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
  const resolved = resolveProviderModel({ provider: args.provider, modelId: args.model });
  if (!resolved) {
    throw new Error(`Provider credential is required for ${args.provider}.`);
  }
  const model = resolved.model;
  const startedAt = new Date().toISOString();

  console.error(`\nAssistant eval · ${resolved.label} · now=${EVAL_NOW.slice(0, 10)}`);
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
      const answer = await askAssistant(model, target, question, {
        model: args.model,
        provider: args.provider,
      });
      const checks = question.grade(answer);
      const passed = checks.filter((check) => check.pass).length;
      const green = passed === checks.length;
      questionResults.push({
        id: question.id,
        dimension: question.dimension,
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
        dimension: question.dimension,
        persona: question.persona,
        status: "error",
        checks: failedChecks(question),
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
  for (const dimension of report.dimensions) {
    console.error(
      `${dimension.meetsThreshold ? "OK  " : "UNDER"} ${dimension.dimension.padEnd(18)} ` +
        `${dimension.passed}/${dimension.total} · ${(dimension.ratio * 100).toFixed(0)}%`,
    );
  }
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
