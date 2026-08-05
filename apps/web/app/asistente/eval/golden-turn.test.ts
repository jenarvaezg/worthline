import { extractedDocumentSchema } from "@web/asistente/attachment-extraction-contract";
import { UNSTRUCTURED_SPREADSHEET_MESSAGE } from "@web/asistente/attachment-types";
import { describe, expect, it } from "vitest";

import { ATTACHMENT_QUESTIONS } from "./golden-attachments";
import type { GoldenQuestion } from "./golden-question";
import { READING_QUESTIONS } from "./golden-reading";
import {
  buildTurnMessages,
  laneOf,
  readGoldenAttachmentTurn,
  unvalidatedEvidenceFor,
  validatedDocumentsFor,
} from "./golden-turn";

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
      expect(question.attachment, question.id).toBeDefined();
      const reading = await readGoldenAttachmentTurn(question.attachment!);
      expect(laneOf(reading), question.id).toBe(question.attachment!.lane);
    }
  });

  it("hands the family's notes to the model as evidence worthline did not validate", async () => {
    const reading = await readGoldenAttachmentTurn({
      file: "apuntes-familia.csv",
      lane: "unstructured",
    });

    expect(reading.preview.result).toEqual({
      message: UNSTRUCTURED_SPREADSHEET_MESSAGE,
      status: "unrecognized",
    });
    // The grid the model actually reads: the ambiguity of «mi cuenta de ahorro» is in
    // the file, not only in the question.
    expect(reading.unstructured?.text).toContain("Fondo de emergencia");
    expect(reading.unstructured?.text).toContain("Ahorro estudios peques");
  });

  it("refuses to grade a turn whose document arrived through another lane", async () => {
    await expect(
      readGoldenAttachmentTurn({ file: "apuntes-familia.csv", lane: "validated" }),
    ).rejects.toThrow(/unstructured/);
  });

  it("fails loudly on a fixture that is not committed", async () => {
    await expect(
      readGoldenAttachmentTurn({ file: "no-existe.csv", lane: "unstructured" }),
    ).rejects.toThrow();
  });

  it("keeps every fixture inside the committed attachments directory", () => {
    // A `..` in a file name would read something outside the eval set — private data
    // on the reviewer's machine, in the worst case, sent to an external provider.
    for (const question of ATTACHMENT_QUESTIONS) {
      expect(question.attachment?.file, question.id).toMatch(/^[\w.-]+\.(csv|png|xlsx)$/);
    }
  });
});

describe("unvalidatedEvidenceFor", () => {
  it("arms the frontier for a document worthline could not validate", async () => {
    const reading = await readGoldenAttachmentTurn({
      file: "apuntes-familia.csv",
      lane: "unstructured",
    });

    expect(unvalidatedEvidenceFor(reading)).toBe(true);
  });

  it("leaves the bulk-import tools open on a turn with no document", () => {
    // The default the reading and tool-discipline sets have always run under: without
    // this, every question would be graded against a gate production would not close.
    expect(unvalidatedEvidenceFor(null)).toBe(false);
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
    const reading = await readGoldenAttachmentTurn({
      file: "apuntes-familia.csv",
      lane: "unstructured",
    });

    expect(validatedDocumentsFor(null)).toEqual([]);
    expect(validatedDocumentsFor(reading)).toEqual([]);
  });
});

describe("buildTurnMessages", () => {
  const ATTACHMENT_QUESTION = ATTACHMENT_QUESTIONS[0]!;

  it("sends a question without a document as one plain user turn", async () => {
    const question = READING_QUESTIONS[0]!;

    const messages = await buildTurnMessages(question, null);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(JSON.stringify(messages[0]?.content)).toContain(question.question);
  });

  it("hands the document to the model behind the production fence", async () => {
    const reading = await readGoldenAttachmentTurn(ATTACHMENT_QUESTION.attachment!);

    const messages = await buildTurnMessages(ATTACHMENT_QUESTION, reading);
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
    const reading = await readGoldenAttachmentTurn(ATTACHMENT_QUESTION.attachment!);

    const messages = await buildTurnMessages(ATTACHMENT_QUESTION, reading);

    expect(JSON.stringify(messages)).not.toContain("data-attachment-extraction");
    expect(JSON.stringify(messages)).not.toContain(UNSTRUCTURED_SPREADSHEET_MESSAGE);
  });

  it("says nothing about a document on a question that carries none", async () => {
    const question: GoldenQuestion = { ...READING_QUESTIONS[0]!, id: "sin-adjunto" };

    const messages = await buildTurnMessages(question, null);

    expect(JSON.stringify(messages)).not.toContain("ADJUNTO");
  });
});
