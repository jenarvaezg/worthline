/**
 * `attachment-registers-the-transfer` is PASSABLE, and it is the incident's shape (#1801).
 *
 * The README warns twice about a plausible check that scores the honest path as a
 * defect. This question grades a model for reaching a traspaso CARD between the two
 * funds its paper names — so if the lane refused this fixture for a reason of its own (a
 * fund the persona does not hold, an identifier that does not match, a date in the
 * harness's future, a price missing), every red would be the harness's.
 *
 * So it is checked here with no provider in the loop: the turn is composed by the same
 * `prepareGoldenTurn` the runner calls, the tools are the route's own slice, and the
 * sanctioned turn is walked step by step — each fund looked up by the ISIN its paper
 * prints, then the traspaso between the two ids those lookups returned.
 *
 * And it checks the one property of the persona the question is about: the destination
 * is worth little and sits below the cut of the portfolio summary, which is what made
 * the model of 2026-10-11 declare a fund it held missing.
 */

import { chatToolStores, createChatTools } from "@web/asistente/chat-tools";
import { proposalCardFrom } from "@web/asistente/proposal-card-presence";
import { seedPersona } from "@web/demo/seed-persona";
import { INVERSOR_SPEC } from "@web/demo/specs/inversor";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ATTACHMENT_QUESTIONS, TRANSFER_CONFIRMATION } from "./golden-attachments";
import { prepareGoldenTurn, readGoldenValidatedDocument } from "./golden-turn";
import type { AssistantAnswer } from "./graders";

const PRIMARY = { model: "gemini-3.1-flash-lite", provider: "google" };
/** The harness's pinned clock (`run.ts`'s `WORTHLINE_DEMO_NOW` default). */
const AS_OF = "2026-06-01";
const LANE_TEST_TIMEOUT_MS = 30_000;

const ORIGIN_LABEL = "Fondo indexado Europa";
const DESTINATION_LABEL = "Fondo indexado renta fija";

const QUESTION = ATTACHMENT_QUESTIONS.find(
  (candidate) => candidate.id === "attachment-registers-the-transfer",
)!;

/**
 * The SDK's tool-call context, as `chat-tools.test.ts` fakes it: none of these tools
 * reads a field of it, and typing the whole thing here would pin this test to the AI
 * SDK's shape for no gain.
 */
function toolCallContext(): never {
  return { toolCallId: "call-1", messages: [] } as unknown as never;
}

/** The two ISINs, read off the fixture the question carries — never typed here. */
async function printedIsins(): Promise<{ origin: string; destination: string }> {
  const preview = await readGoldenValidatedDocument(TRANSFER_CONFIRMATION);
  if (preview.result.status !== "valid") throw new Error("fixture did not validate");
  const document = preview.result.data;
  if (document.documentType !== "transfer") throw new Error("fixture is no transfer");
  return {
    destination: document.transfer.destination.isin!,
    origin: document.transfer.origin.isin!,
  };
}

interface HoldingRow {
  id: string;
  label: string;
}

describe("the traspaso lane over attachment-registers-the-transfer (#1801)", () => {
  let store: WorthlineStore;

  beforeEach(async () => {
    store = await createInMemoryStore();
    await seedPersona(store, INVERSOR_SPEC, AS_OF);
  }, LANE_TEST_TIMEOUT_MS);

  afterEach(() => {
    store.close();
  });

  async function turnTools() {
    const turn = await prepareGoldenTurn(QUESTION, PRIMARY, AS_OF);
    return createChatTools({
      runWithStore: (run) => run(chatToolStores(store)),
      asOf: AS_OF,
      unvalidatedEvidence: turn.unvalidatedEvidence,
      validatedAttachments: turn.validatedAttachments,
      validatedDocuments: turn.validatedDocuments,
    });
  }

  it(
    "leaves the destination below the summary's cut and keeps the origin in it",
    async () => {
      const tools = await turnTools();

      const context = (await tools["get_financial_context"]?.execute?.(
        {},
        toolCallContext(),
      )) as { holdings: HoldingRow[] };
      const labels = context.holdings.map((holding) => holding.label);

      expect(labels).toContain(ORIGIN_LABEL);
      expect(labels).not.toContain(DESTINATION_LABEL);
    },
    LANE_TEST_TIMEOUT_MS,
  );

  it(
    "finds each fund by the ISIN its paper prints",
    async () => {
      const tools = await turnTools();
      const isins = await printedIsins();

      for (const [isin, label] of [
        [isins.origin, ORIGIN_LABEL],
        [isins.destination, DESTINATION_LABEL],
      ] as const) {
        const found = (await tools["find_holdings"]?.execute?.(
          { query: isin },
          toolCallContext(),
        )) as { matches: HoldingRow[] };
        expect(
          found.matches.map((match) => match.label),
          isin,
        ).toEqual([label]);
      }
    },
    LANE_TEST_TIMEOUT_MS,
  );

  it(
    "answers the sanctioned turn with a card, and the question scores it whole",
    async () => {
      const tools = await turnTools();
      const isins = await printedIsins();
      const answer: AssistantAnswer = {
        quickActions: [],
        text:
          "He encontrado los dos fondos por su ISIN y te dejo preparado el traspaso del " +
          "Fondo indexado Europa al Fondo indexado renta fija con las cifras del " +
          "justificante. Revisa la tarjeta y confírmalo si está bien.",
        toolCalls: [],
        toolResults: [],
      };
      const call = async (name: string, input: Record<string, unknown>) => {
        const output = await tools[name]?.execute?.(input, toolCallContext());
        answer.toolCalls.push({ input, name });
        answer.toolResults.push({ name, output });
        return output;
      };

      const origin = (await call("find_holdings", { query: isins.origin })) as {
        matches: HoldingRow[];
      };
      const destination = (await call("find_holdings", {
        query: isins.destination,
      })) as { matches: HoldingRow[] };
      const proposal = await call("propose_transfer", {
        destinationHoldingId: destination.matches[0]!.id,
        originHoldingId: origin.matches[0]!.id,
      });

      // Graded through the same reader the question's check uses, so «passable» here
      // and «passed» there cannot mean two different things.
      expect(proposalCardFrom("propose_transfer", proposal)).not.toBeNull();
      expect(QUESTION.grade(answer).filter((check) => !check.pass)).toEqual([]);
    },
    LANE_TEST_TIMEOUT_MS,
  );
});
