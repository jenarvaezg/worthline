import { STATEMENT_GATE_FORMATS } from "@web/patrimonio/importar-extracto/statement-upload-read";
import { describe, expect, it } from "vitest";

import { STATEMENT_DOCUMENT_REQUIRED_MESSAGE } from "./statement-from-transactions-document";
import { buildChatSystemPrompt } from "./system-prompt";
import {
  UNVALIDATED_EVIDENCE_CAP_MESSAGE,
  UNVALIDATED_EVIDENCE_MESSAGE,
} from "./unvalidated-evidence-gate";
import { UNVALIDATED_EVIDENCE_NOTE } from "./unvalidated-evidence-notice";

/**
 * The gate cannot be promised what it does not read (#1488).
 *
 * The ticket's second half is a real conversation: after refusing a DEGIRO
 * `Transactions.xlsx`, the assistant told its owner the «correct» route was
 * /patrimonio/importar-extracto, where the file would reconcile «de forma atómica y
 * precisa». It would not have — the gate spoke one format, the plantilla — and nobody
 * had written down anywhere what the gate speaks, so the model could not have known.
 *
 * So every text that sends someone to that door names what the door reads, and all of
 * them read it off {@link STATEMENT_GATE_FORMATS}, the list the reader itself exports.
 * A format added there reaches this copy; a format invented in prose fails here.
 *
 * The list is checked against the ROUTING texts and not against every mention: the
 * schedule tab's own copy (#1406) is about a different reader behind the same door, and
 * a rule that demanded the formats beside every URL would be satisfied by noise.
 */
const ROUTING_TEXTS: Record<string, string> = {
  STATEMENT_DOCUMENT_REQUIRED_MESSAGE,
  UNVALIDATED_EVIDENCE_CAP_MESSAGE,
  UNVALIDATED_EVIDENCE_MESSAGE,
  UNVALIDATED_EVIDENCE_NOTE,
  systemPrompt: buildChatSystemPrompt(null),
};

describe("what the statement gate is promised", () => {
  it.each(
    Object.keys(ROUTING_TEXTS),
  )("%s names the formats the gate reads, never the door alone", (name) => {
    const text = ROUTING_TEXTS[name]!;

    expect(text).toContain("/patrimonio/importar-extracto");
    for (const format of STATEMENT_GATE_FORMATS) {
      expect(text).toContain(format);
    }
  });

  it("keeps the list plural: the gate reads more than the plantilla since #1488", () => {
    expect(STATEMENT_GATE_FORMATS.length).toBeGreaterThan(1);
    expect(STATEMENT_GATE_FORMATS).toContain("la plantilla de worthline");
  });
});
