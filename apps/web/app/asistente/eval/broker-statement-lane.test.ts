/**
 * The two new questions are PASSABLE (#1516).
 *
 * This README warns twice about the same failure: a plausible check that scores the
 * honest path as a defect. `attachment-imports-the-broker-statement` grades a model for
 * reaching `propose_statement_import` and getting a CARD back — so if that lane refused
 * this fixture for a reason of its own (the gate armed, a document the frontier does not
 * recognise, a proposal that cannot be built against this persona), the question would
 * be unpassable and every red would be the harness's.
 *
 * So it is checked here, with no provider in the loop: the turn is composed by the same
 * `prepareGoldenTurn` the runner calls, the tools are the route's own slice, and the
 * lane is invoked exactly as its description tells a model to invoke it — with no
 * arguments, letting the app use the document it read.
 */

import { chatToolStores, createChatTools } from "@web/asistente/chat-tools";
import { proposalCardFrom } from "@web/asistente/proposal-card-presence";
import { seedPersona } from "@web/demo/seed-persona";
import { INVERSOR_SPEC } from "@web/demo/specs/inversor";
import { createInMemoryStore } from "@worthline/db";
import { describe, expect, it } from "vitest";

import { ATTACHMENT_QUESTIONS } from "./golden-attachments";
import { prepareGoldenTurn } from "./golden-turn";

const PRIMARY = { model: "gemini-3.1-flash-lite", provider: "google" };
const AS_OF = "2026-06-01";
const LANE_TEST_TIMEOUT_MS = 30_000;

/**
 * The SDK's tool-call context, as `chat-tools.test.ts` fakes it: none of these tools
 * reads a field of it, and typing the whole thing here would pin this test to the AI
 * SDK's shape for no gain.
 */
function toolCallContext(): never {
  return { toolCallId: "call-1", messages: [] } as unknown as never;
}

describe("the statement lane over the broker-transactions questions", () => {
  it.each([
    "attachment-imports-the-broker-statement",
    "attachment-imports-the-statement-read-earlier",
  ])(
    "answers %s with a proposal that paints",
    async (id) => {
      const question = ATTACHMENT_QUESTIONS.find((candidate) => candidate.id === id)!;
      const turn = await prepareGoldenTurn(question, PRIMARY, AS_OF);
      const store = await createInMemoryStore();
      await seedPersona(store, INVERSOR_SPEC, AS_OF);

      const tools = createChatTools({
        runWithStore: (run) => run(chatToolStores(store)),
        asOf: AS_OF,
        unvalidatedEvidence: turn.unvalidatedEvidence,
        validatedAttachments: turn.validatedAttachments,
        validatedDocuments: turn.validatedDocuments,
      });
      const output = await tools["propose_statement_import"]?.execute?.(
        {},
        toolCallContext(),
      );

      // Graded through the same reader the question's check uses, so «passable» here
      // and «passed» there cannot mean two different things.
      expect(proposalCardFrom("propose_statement_import", output)).not.toBeNull();
      store.close();
    },
    LANE_TEST_TIMEOUT_MS,
  );
});
