/**
 * Writes the two committed fixtures of #1516 from one source: the DEGIRO workbook and
 * the extraction envelope derived from it.
 *
 * Its own script rather than a `main` block inside `broker-transactions-fixture.ts`,
 * because that module is imported by the question set for two file NAMES: pulling the
 * attachment pipeline in behind them, or reaching for a dynamic import to avoid it,
 * would both be paid by every importer. Here the imports sit at the top and cost
 * nothing, because nothing imports this.
 *
 * Usage (from the repo root):
 *   bun run apps/web/app/asistente/eval/write-broker-transactions-fixture.ts
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAttachmentTurn } from "@web/asistente/attachment-turn";
import { attachmentMimeTypeForFileName } from "@web/asistente/attachment-types";

import {
  BROKER_TRANSACTIONS_DOCUMENT_FILE,
  BROKER_TRANSACTIONS_FIXTURE_FILE,
  buildBrokerTransactionsWorkbook,
} from "./broker-transactions-fixture";

/** The harness's pinned clock, so a regeneration cannot re-date the reading. */
const TODAY = "2026-06-01";

const directory = dirname(fileURLToPath(import.meta.url));
const bytes = buildBrokerTransactionsWorkbook();

const workbookPath = join(directory, "attachments", BROKER_TRANSACTIONS_FIXTURE_FILE);
await writeFile(workbookPath, bytes);
console.error(`Wrote ${workbookPath}`);

// The envelope is DERIVED from the workbook through the production reader rather than
// typed by hand. Deriving it is not what KEEPS them in step, though — regenerating one
// half and not the other would leave the two questions grading different documents —
// so `broker-transactions-fixture.test.ts` reads the committed workbook and compares
// the reading against the committed envelope. That test is the guarantee; this is the
// convenience.
const reading = await readAttachmentTurn({
  bytes,
  fileName: BROKER_TRANSACTIONS_FIXTURE_FILE,
  mimeType: attachmentMimeTypeForFileName(BROKER_TRANSACTIONS_FIXTURE_FILE),
  today: TODAY,
});
if (reading.preview.result.status !== "valid") {
  throw new Error("The workbook no longer reads as a validated document.");
}

const documentPath = join(directory, "documents", BROKER_TRANSACTIONS_DOCUMENT_FILE);
await writeFile(documentPath, `${JSON.stringify(reading.preview, null, 2)}\n`);
console.error(`Wrote ${documentPath}`);
