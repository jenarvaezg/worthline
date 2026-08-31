/**
 * The committed `.xlsx` still says what its source says (#1516).
 *
 * A binary fixture in a public repo is only reviewable while the text beside it is
 * true, and nothing else in CI would notice the two parting ways: the lane assertion
 * in `golden-turn.test.ts` would keep passing over a workbook whose figures had
 * drifted, because it only asks WHICH lane the document arrived through.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAttachmentTurn } from "@web/asistente/attachment-turn";
import { attachmentMimeTypeForFileName } from "@web/asistente/attachment-types";
import { readSpreadsheetGrids } from "@web/spreadsheet-grid";
import { describe, expect, it } from "vitest";

import {
  BROKER_TRANSACTIONS_DOCUMENT_FILE,
  BROKER_TRANSACTIONS_FIXTURE_FILE,
  BROKER_TRANSACTIONS_GRID,
  buildBrokerTransactionsWorkbook,
  buildWorkbook,
} from "./broker-transactions-fixture";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(DIRECTORY, "attachments", BROKER_TRANSACTIONS_FIXTURE_FILE);
const DOCUMENT_PATH = join(DIRECTORY, "documents", BROKER_TRANSACTIONS_DOCUMENT_FILE);

/** The date the generator reads the workbook with — the harness's own pinned clock. */
const FIXTURE_TODAY = "2026-06-01";

/** Trailing empty cells are not carried by a sheet, so compare on the stated width. */
function trimTrailingBlanks(cells: readonly string[]): string[] {
  const copy = [...cells];
  while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop();
  return copy;
}

describe("the committed broker transactions fixture", () => {
  it("carries exactly the grid its source declares", async () => {
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH));

    const grids = readSpreadsheetGrids({
      bytes,
      fileName: BROKER_TRANSACTIONS_FIXTURE_FILE,
    });

    expect(grids.status).toBe("ok");
    if (grids.status !== "ok") return;
    const sheet = grids.sheets[0];
    expect(sheet?.rows.map(trimTrailingBlanks)).toEqual(
      BROKER_TRANSACTIONS_GRID.map(trimTrailingBlanks),
    );
  });

  it("reads back the same workbook its generator writes today", async () => {
    // The regeneration command in the source header is only useful while it produces
    // the committed file: a generator that silently stopped matching would leave the
    // next person editing the grid with a fixture they cannot reproduce.
    //
    // Compared as GRIDS and not as bytes: a zip records a modification time, so the
    // same workbook written twice is two different files — and a byte comparison would
    // fail for the clock rather than for the content.
    const generated = readSpreadsheetGrids({
      bytes: buildBrokerTransactionsWorkbook(),
      fileName: BROKER_TRANSACTIONS_FIXTURE_FILE,
    });
    const committed = readSpreadsheetGrids({
      bytes: new Uint8Array(await readFile(FIXTURE_PATH)),
      fileName: BROKER_TRANSACTIONS_FIXTURE_FILE,
    });

    expect(generated).toEqual(committed);
  });

  it("keeps the three facts #1513 measured on the real export", () => {
    // Eleven rows, three instruments, and costs adding up to the 16,80 € the
    // extraction card printed for Jorge. Asserted off the SOURCE, so the numbers a
    // reader checks against the issue are the numbers CI checks too.
    const rows = BROKER_TRANSACTIONS_GRID.slice(1);
    expect(rows).toHaveLength(11);
    expect(new Set(rows.map((row) => row[3]))).toEqual(
      new Set(["IE00B52MJY50", "IE00BM67HK77", "US18915M1071"]),
    );
    const costsMinor = rows.reduce(
      (total, row) => total + Math.round(Number(row[14]!.replace(",", ".")) * 100),
      0,
    );
    expect(costsMinor).toBe(-16_80);
  });

  it("survives a cell the writer would otherwise corrupt", () => {
    // The two ways an edited grid could write a broken workbook in silence: a product
    // name with an `&` («PROCTER & GAMBLE» is an ordinary DEGIRO row), and a grid wider
    // than column Z. Both come back out of the reader intact or this fails.
    const wide = Array.from({ length: 28 }, (_, index) => `c${index}`);
    const rows = [wide, [...wide.slice(0, 27), "PROCTER & GAMBLE <ADR>"]];

    const grids = readSpreadsheetGrids({
      bytes: buildWorkbook(rows),
      fileName: BROKER_TRANSACTIONS_FIXTURE_FILE,
    });

    expect(grids.status).toBe("ok");
    if (grids.status !== "ok") return;
    expect(grids.sheets[0]?.rows).toEqual(rows);
  });

  it("keeps the history envelope describing the SAME document as the workbook", async () => {
    // The two fixtures are written by one script from one grid, and the second question
    // grades a turn built from the envelope alone — so nothing else in CI would notice
    // a grid edited and only half regenerated: the workbook test compares against the
    // source, and `readGoldenValidatedDocument` only revalidates the envelope's schema.
    // Both questions would then be grading two different documents, silently.
    const bytes = new Uint8Array(await readFile(FIXTURE_PATH));
    const reading = await readAttachmentTurn({
      bytes,
      fileName: BROKER_TRANSACTIONS_FIXTURE_FILE,
      mimeType: attachmentMimeTypeForFileName(BROKER_TRANSACTIONS_FIXTURE_FILE),
      today: FIXTURE_TODAY,
    });
    const committed = JSON.parse(await readFile(DOCUMENT_PATH, "utf8"));

    expect(committed).toEqual(JSON.parse(JSON.stringify(reading.preview)));
  });

  it("dates every row before the harness's pinned clock", () => {
    // `WORTHLINE_DEMO_NOW` is 2026-06-01: a row dated after it would give a model an
    // honest reason to refuse, and the question would fail for a harness reason.
    for (const row of BROKER_TRANSACTIONS_GRID.slice(1)) {
      const [day, month, year] = row[0]!.split("-");
      expect(`${year}-${month}-${day}` < "2026-06-01", row[0]).toBe(true);
    }
  });
});
