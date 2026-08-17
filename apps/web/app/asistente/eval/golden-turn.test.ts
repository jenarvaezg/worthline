import { extractedDocumentSchema } from "@web/asistente/attachment-extraction-contract";
import { UNSTRUCTURED_SPREADSHEET_MESSAGE } from "@web/asistente/attachment-types";
import { holdingEventInContext } from "@web/asistente/operation-document-frontier";
import { describe, expect, it } from "vitest";

import { ATTACHMENT_QUESTIONS, SUBSCRIPTION_RECEIPT } from "./golden-attachments";
import type { GoldenQuestion } from "./golden-question";
import { READING_QUESTIONS } from "./golden-reading";
import {
  buildTurnMessages,
  documentHistoryMessages,
  laneOf,
  prepareGoldenTurn,
  readGoldenAttachmentTurn,
  readGoldenValidatedDocument,
  typedBalanceSeriesFor,
  unvalidatedEvidenceFor,
  validatedDocumentsFor,
} from "./golden-turn";

/**
 * The provider the turn is fitted to, since #1419 made that a per-model decision: the
 * primary is what answers virtually every production turn, so it is what the harness
 * grades against unless a run says otherwise.
 */
const PRIMARY = { model: "gemini-3.1-flash-lite", provider: "google" };
/**
 * The turn's date the reading seam now needs (#1424). At run time it is the harness's
 * pinned clock through `chatAsOf`; here it only has to be A valid day, because no
 * fixture in this file is a dated balance series — so this constant deliberately does
 * NOT claim to track `WORTHLINE_DEMO_NOW`, which would be a coupling nothing asserts.
 */
const TODAY = "2026-06-01";
/** Wide enough that no fixture in here is sampled by accident. */
const WIDE_BUDGET = 200_000;

describe("golden attachments", () => {
  /**
   * The #1254 tripwire, pointed at this harness rather than at the extractor's: every
   * attachment a question declares must exist and must arrive through the lane the
   * question says it does. A missing file or a fixture that silently started
   * validating would make the write-path checks green for a frontier that never
   * engaged — a harness promising coverage it does not have, which is the defect this
   * whole issue is about.
   *
   * It runs in CI without any API key because every fixture is a spreadsheet: that
   * route is deterministic and model-free. An image fixture could not be verified
   * here, only at run time by the same assertion.
   */
  it("reads every declared attachment through the lane its question claims", async () => {
    expect(ATTACHMENT_QUESTIONS.length).toBeGreaterThanOrEqual(3);
    for (const question of ATTACHMENT_QUESTIONS) {
      // That every question in this dimension carries a document by exactly one of the
      // two routes is `golden.test.ts`' invariant; here we only read the ones that
      // declare an attachment.
      if (!question.attachment) continue;
      const reading = await readGoldenAttachmentTurn(question.attachment, TODAY);
      expect(laneOf(reading), question.id).toBe(question.attachment.lane);
    }
  });

  it("hands the family's notes to the model as evidence worthline did not validate", async () => {
    const reading = await readGoldenAttachmentTurn(
      {
        file: "apuntes-familia.csv",
        lane: "unstructured",
      },
      TODAY,
    );

    expect(reading.preview.result).toEqual({
      message: UNSTRUCTURED_SPREADSHEET_MESSAGE,
      status: "unrecognized",
    });
    // The grid the model actually reads: the ambiguity of «mi cuenta de ahorro» is in
    // the file, not only in the question.
    const block = reading.unstructured?.fitTo(WIDE_BUDGET);
    expect(block?.text).toContain("Fondo de emergencia");
    expect(block?.text).toContain("Ahorro estudios peques");
  });

  it("refuses to grade a turn whose document arrived through another lane", async () => {
    await expect(
      readGoldenAttachmentTurn({ file: "apuntes-familia.csv", lane: "validated" }, TODAY),
    ).rejects.toThrow(/unstructured/);
  });

  it("fails loudly on a fixture that is not committed", async () => {
    await expect(
      readGoldenAttachmentTurn({ file: "no-existe.csv", lane: "unstructured" }, TODAY),
    ).rejects.toThrow();
  });

  it("keeps every fixture inside the committed attachments directory", () => {
    // A `..` in a file name would read something outside the eval set — private data
    // on the reviewer's machine, in the worst case, sent to an external provider.
    for (const question of ATTACHMENT_QUESTIONS) {
      if (question.attachment) {
        expect(question.attachment.file, question.id).toMatch(
          /^[\w.-]+\.(csv|png|xlsx)$/,
        );
      }
      if (question.validatedDocument) {
        expect(question.validatedDocument.file, question.id).toMatch(/^[\w.-]+\.json$/);
      }
    }
  });
});

describe("golden validated documents (#1376)", () => {
  // The question's own fixture, not a copy of its coordinates: a test that named the
  // file itself could keep passing while the question pointed somewhere else.
  const RECEIPT = SUBSCRIPTION_RECEIPT;

  /**
   * The #1254 tripwire, for the other route a document takes. It runs with no API key
   * for the same reason the attachment one does, and it is stronger than it looks: the
   * fixture is revalidated through the production parser, so a contract change that
   * stopped accepting it (a tightened field, a renamed key) fails HERE rather than as
   * a mysterious refusal in a live run three weeks later.
   */
  it("revalidates every declared document as the document its question claims", async () => {
    for (const question of ATTACHMENT_QUESTIONS) {
      if (!question.validatedDocument) continue;
      const preview = await readGoldenValidatedDocument(question.validatedDocument);
      expect(preview.result.status, question.id).toBe("valid");
    }
  });

  it("hands the receipt to `propose_operation` as the fact it may write", async () => {
    // The lane assertion that matters for this question: the tool takes its date,
    // amount, participaciones and commission from HERE, and refuses outright when the
    // list is empty. A harness that composed the history but not this would grade
    // `operation_document_required` on every run — its own hole, not the model.
    const history = documentHistoryMessages(await readGoldenValidatedDocument(RECEIPT));

    const event = holdingEventInContext(validatedDocumentsFor(null, history))?.event;

    expect(event?.date).toBe("2026-05-29");
    expect(event?.amount).toBe(480);
    expect(event?.units).toBe(13.7213);
    expect(event?.label).toContain("SMALL CAP");
  });

  it("refuses to grade a fixture that parsed as another document", async () => {
    await expect(
      readGoldenValidatedDocument({ ...RECEIPT, documentType: "positions" }),
    ).rejects.toThrow(/holding_event/);
  });

  it("fails loudly on a document that is not committed", async () => {
    await expect(
      readGoldenValidatedDocument({
        file: "no-existe.json",
        documentType: "holding_event",
      }),
    ).rejects.toThrow();
  });
});

describe("unvalidatedEvidenceFor", () => {
  it("arms the frontier for a document worthline could not validate", async () => {
    const reading = await readGoldenAttachmentTurn(
      {
        file: "apuntes-familia.csv",
        lane: "unstructured",
      },
      TODAY,
    );

    expect(unvalidatedEvidenceFor(reading)).toBe(true);
  });

  it("leaves the bulk-import tools open on a turn with no document", () => {
    // The default the reading and tool-discipline sets have always run under: without
    // this, every question would be graded against a gate production would not close.
    expect(unvalidatedEvidenceFor(null)).toBe(false);
  });
});

describe("typedBalanceSeriesFor (#1418)", () => {
  const question = (text: string): GoldenQuestion =>
    ({ id: "q", question: text }) as GoldenQuestion;
  const SERIES = "01/10/2025 198.456,78\n01/11/2025 197.925,68";

  it("hands the tools the series the question types under a closed gate", () => {
    // The harness has been wrong in this exact shape twice (#1265, #1373): forwarding
    // the frontier without what reopens it would refuse a legitimate turn and score it
    // as the model refusing.
    expect(typedBalanceSeriesFor(question(SERIES), true)).toEqual({
      rows: [
        { balanceMinor: 19845678, date: "2025-10-01" },
        { balanceMinor: 19792568, date: "2025-11-01" },
      ],
      status: "read",
    });
  });

  it("stays absent on an open turn, exactly as the route leaves it", () => {
    expect(typedBalanceSeriesFor(question(SERIES), false)).toEqual({ status: "absent" });
  });

  it("stays absent for a question that types no series", () => {
    expect(typedBalanceSeriesFor(question("¿cuánto debo de la hipoteca?"), true)).toEqual(
      {
        status: "absent",
      },
    );
  });
});

describe("validatedDocumentsFor", () => {
  it("hands the tools the document the turn validated (#1373)", () => {
    // The reconcile lane takes its rows from here. A harness that forwarded the gate
    // but not the documents would grade `reconcile_document_required` on every
    // question — its own hole, not the model, exactly as #1265 found with the stores.
    const data = extractedDocumentSchema.parse({
      documentType: "positions_movements",
      holdings: [
        {
          name: "Amundi MSCI World",
          type: "Fondo",
          value: 12_000,
          currency: "EUR",
          fidelity: "value_only",
        },
      ],
      movements: [],
      warnings: [],
    });

    expect(
      validatedDocumentsFor({
        preview: { fileName: "cartera.csv", result: { data, status: "valid" } },
        unstructured: null,
        visionCalls: 0,
      }),
    ).toEqual([data]);
  });

  it("hands nothing on a turn with no document, and nothing on an unreadable one", async () => {
    const reading = await readGoldenAttachmentTurn(
      {
        file: "apuntes-familia.csv",
        lane: "unstructured",
      },
      TODAY,
    );

    expect(validatedDocumentsFor(null)).toEqual([]);
    expect(validatedDocumentsFor(reading)).toEqual([]);
  });
});

describe("buildTurnMessages", () => {
  const ATTACHMENT_QUESTION = ATTACHMENT_QUESTIONS[0]!;

  it("sends a question without a document as one plain user turn", async () => {
    const question = READING_QUESTIONS[0]!;

    const messages = await buildTurnMessages(question, null, PRIMARY);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(JSON.stringify(messages[0]?.content)).toContain(question.question);
  });

  it("hands the document to the model behind the production fence", async () => {
    const reading = await readGoldenAttachmentTurn(
      ATTACHMENT_QUESTION.attachment!,
      TODAY,
    );

    const messages = await buildTurnMessages(ATTACHMENT_QUESTION, reading, PRIMARY);
    const serialized = JSON.stringify(messages);

    // The fence and the framing are the route's, not a paraphrase: what is measured is
    // how a model behaves against the prompt production actually builds.
    expect(serialized).toContain("ADJUNTO NO ESTRUCTURADO");
    expect(serialized).toContain("nunca una importación en bloque");
    expect(serialized).toContain("Cuenta corriente conjunta");
    expect(serialized).toContain(ATTACHMENT_QUESTION.question);
  });

  it("never leaks a preview part into the model turn", async () => {
    // The card is UI, not context. It rides the stream in production and must not
    // reach the provider here either — that is what `prepareAttachmentMessagesForModel`
    // strips, and the reason this harness calls it instead of assembling its own turn.
    const reading = await readGoldenAttachmentTurn(
      ATTACHMENT_QUESTION.attachment!,
      TODAY,
    );

    const messages = await buildTurnMessages(ATTACHMENT_QUESTION, reading, PRIMARY);

    expect(JSON.stringify(messages)).not.toContain("data-attachment-extraction");
    expect(JSON.stringify(messages)).not.toContain(UNSTRUCTURED_SPREADSHEET_MESSAGE);
  });

  it("says nothing about a document on a question that carries none", async () => {
    const question: GoldenQuestion = { ...READING_QUESTIONS[0]!, id: "sin-adjunto" };

    const messages = await buildTurnMessages(question, null, PRIMARY);

    expect(JSON.stringify(messages)).not.toContain("ADJUNTO");
  });

  it("carries a document validated one turn earlier behind the validated fence", async () => {
    const question = ATTACHMENT_QUESTIONS.find(
      (candidate) => candidate.validatedDocument,
    )!;
    const history = documentHistoryMessages(
      await readGoldenValidatedDocument(question.validatedDocument!),
    );

    const messages = await buildTurnMessages(question, null, PRIMARY, history);
    const serialized = JSON.stringify(messages);

    // The fence that means «validated by worthline» — the one an unstructured turn
    // never gets — plus the receipt's own figures, and the question asked on top.
    expect(serialized).toContain("DATOS ESTRUCTURADOS DE ADJUNTOS");
    expect(serialized).toContain("SMALL CAP");
    expect(serialized).toContain("2026-05-29");
    expect(serialized).toContain(question.question);
    // The card stays UI here too: what travels is the extraction, never the payload the
    // browser painted.
    expect(serialized).not.toContain("data-attachment-extraction");
    // And nothing in the history decides what the question grades: no holding named, no
    // direction given, no figure repeated by the assistant.
    expect(serialized).not.toContain("ETF MSCI World");
  });
});

describe("prepareGoldenTurn", () => {
  it("hands the receipt question its messages, its gate and its documents at once", async () => {
    // The single call the runner makes. All three halves come from it, because both bugs
    // this harness has had were a caller that forwarded some of them and not the rest.
    const question = ATTACHMENT_QUESTIONS.find(
      (candidate) => candidate.validatedDocument,
    )!;

    const turn = await prepareGoldenTurn(question, PRIMARY, TODAY);

    expect(JSON.stringify(turn.messages)).toContain("DATOS ESTRUCTURADOS DE ADJUNTOS");
    // No document arrived in THIS turn, so the #1248 gate has nothing to close over.
    expect(turn.unvalidatedEvidence).toBe(false);
    expect(turn.validatedDocuments.map((document) => document.documentType)).toEqual([
      "holding_event",
    ]);
  });

  it("arms the gate and hands no document on an unstructured attachment question", async () => {
    const question = ATTACHMENT_QUESTIONS.find((candidate) => candidate.attachment)!;

    const turn = await prepareGoldenTurn(question, PRIMARY, TODAY);

    expect(turn.unvalidatedEvidence).toBe(true);
    expect(turn.validatedDocuments).toEqual([]);
  });

  it("composes a plain turn for a question with no document at all", async () => {
    const turn = await prepareGoldenTurn(READING_QUESTIONS[0]!, PRIMARY, TODAY);

    expect(turn.messages).toHaveLength(1);
    expect(turn.unvalidatedEvidence).toBe(false);
    expect(turn.validatedDocuments).toEqual([]);
  });
});
