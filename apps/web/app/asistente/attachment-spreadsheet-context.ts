import { readSpreadsheetGrids, type SpreadsheetGridInput } from "@web/spreadsheet-grid";

/**
 * A readable-but-unrecognized spreadsheet, rendered as plain text so the assistant can
 * describe what it sees instead of dead-ending (#865) — the whole book, fitted to what
 * the model about to read it can carry (#1419).
 *
 * It used to be four constants: eight sheets, sixty rows per sheet, twenty columns and
 * twelve thousand characters. They were written when the WHOLE conversation lived or
 * died inside 16 000 characters, so 12 000 for one workbook was nearly the entire
 * budget and cutting was not a choice. #1408 removed that ceiling — prose is per model
 * now, and `gemini-3.1-flash-lite`, which answers virtually every turn, accepts
 * ~3 000 000 characters. The constants outlived their reason, and a real workbook
 * showed what they cost: 13 sheets of which 5 never arrived, a 425-row amortisation
 * plan cut at row 60, and the model reaching for a hypothetical figure it found in one
 * of the seven personal-analysis sheets that DID arrive, because nothing told it which
 * of the eight was the document and which were notes in the margin.
 *
 * So three things changed, and they are different things:
 *
 * 1. **No count-shaped bound survives.** Sheets, rows and columns are not capped. The
 *    only limit left is the one that cannot not exist — an `.xlsx` is untrusted input
 *    and the decompression guard admits up to 16 MiB of cells — and it is the MODEL's,
 *    passed in by the caller once the provider that will answer is known.
 * 2. **A cut is a SAMPLE, never a prefix.** The first sixty rows of a thirty-year
 *    amortisation table are the first five years: the worst possible selection for
 *    both questions anyone asks of a dated series (what happened, and where it stands).
 *    {@link sampleIndices} keeps the head, the tail and a regular step through the
 *    middle, and the notice says so — a prefix lies about a series, a sample does not.
 * 3. **Every sheet is named by its SHAPE.** Position in the book, rows, columns and
 *    whether it was sampled. With the whole book delivered this matters MORE, not less:
 *    thirteen indistinguishable blocks of text are what made a 2020 what-if look like
 *    a bank figure.
 *
 * Reading is separated from rendering on purpose ({@link readSpreadsheetContext}
 * returns something renderable, not text): the route builds one prompt PER PROVIDER,
 * and the fallback's budget is an order of magnitude below the primary's. Rendering
 * once and trimming afterwards would either hand the narrow provider a book it must
 * reject or hold the wide one to the narrow one's ration — the exact mistake #1408
 * removed from the prose lane.
 */

/** One cell is not a series, so clamping one loses no shape — and it says so. */
const MAX_CELL_CHARS = 120;

/** How a sample is split: a quarter at the head, a quarter at the tail, the rest stepped. */
const HEAD_SHARE = 0.25;
const TAIL_SHARE = 0.25;

const SHEET_SEPARATOR = "\n\n";

interface SheetDraft {
  /** 1-based position among the sheets that carry anything. */
  position: number;
  name: string;
  columns: number;
  /** Every row of the sheet, already rendered as a line. */
  rows: string[];
}

/** A workbook read once, renderable as many times as there are providers to try. */
export interface SpreadsheetContext {
  /** The whole book as text, sampled only as far as `budgetChars` forces. */
  render: (budgetChars: number) => string;
}

/**
 * Read a spreadsheet for conversation. Returns null when the bytes cannot be read at
 * all, or carry no cell with content — the caller then falls back to the honest canned
 * failure rather than handing the model an empty fence.
 */
export function readSpreadsheetContext(
  input: SpreadsheetGridInput,
): SpreadsheetContext | null {
  const grids = readSpreadsheetGrids(input);
  if (grids.status !== "ok") return null;

  const drafts: SheetDraft[] = [];
  for (const sheet of grids.sheets) {
    // Whitespace-only sheets are dropped rather than rendered as "0 fila(s)" noise,
    // and the position is assigned after the drop so «hoja 3/9» counts what is there.
    const draft = draftOf(sheet, drafts.length + 1);
    if (draft) drafts.push(draft);
  }
  if (drafts.length === 0) return null;

  return { render: (budgetChars) => renderBook(drafts, budgetChars) };
}

function draftOf(
  sheet: { name: string; rows: string[][] },
  position: number,
): SheetDraft | null {
  const dataRows = sheet.rows.filter((row) => row.some((cell) => cell.trim() !== ""));
  if (dataRows.length === 0) return null;
  const columns = dataRows.reduce((max, row) => Math.max(max, row.length), 0);
  return {
    columns,
    name: sheet.name.trim(),
    position,
    rows: dataRows.map((row) =>
      Array.from({ length: columns }, (_unused, column) =>
        clampCell(row[column] ?? ""),
      ).join(" | "),
    ),
  };
}

function clampCell(cell: string): string {
  const value = cell.trim().replace(/\s+/g, " ");
  return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value;
}

function renderBook(drafts: readonly SheetDraft[], budgetChars: number): string {
  const budget = Math.max(0, Math.floor(budgetChars));
  const costs = drafts.map((draft) => wholeSheet(draft, drafts.length).length);
  const shares = fairShares(costs, budget);

  const parts: string[] = [];
  let used = 0;
  for (const [index, draft] of drafts.entries()) {
    const text = fitSheet(draft, drafts.length, shares[index]!);
    const cost = text.length + (parts.length === 0 ? 0 : SHEET_SEPARATOR.length);
    // A sheet whose share does not even cover its own title line is the last resort,
    // and the only place a whole sheet is still dropped. It is derived from the
    // budget rather than from a constant, and it is announced.
    if (parts.length > 0 && used + cost > budget) break;
    parts.push(text);
    used += cost;
  }

  const notice =
    parts.length < drafts.length ? droppedSheetsNotice(parts.length, drafts.length) : "";
  return `${parts.join(SHEET_SEPARATOR)}${notice}`;
}

/**
 * Max-min fair division of the budget across the sheets: everyone is offered an equal
 * share, whoever needs less takes only what they need, and what they leave is shared
 * again among the rest. So a book of twelve small analyses and one 425-row plan spends
 * almost everything on the plan — without the twelve disappearing, which is the failure
 * a proportional split would reproduce.
 */
function fairShares(costs: readonly number[], budget: number): number[] {
  const shares = costs.map(() => 0);
  const cheapestFirst = costs
    .map((cost, index) => ({ cost, index }))
    .sort((left, right) => left.cost - right.cost);

  let remaining = budget;
  let pending = cheapestFirst.length;
  for (const { cost, index } of cheapestFirst) {
    const share = Math.floor(remaining / pending);
    const given = Math.min(cost, share);
    shares[index] = given;
    remaining -= given;
    pending -= 1;
  }
  return shares;
}

function fitSheet(draft: SheetDraft, total: number, allowance: number): string {
  const whole = wholeSheet(draft, total);
  if (whole.length <= allowance) return whole;

  // Largest sample that fits. Rows differ in length, so this is a search and not a
  // division: `keep` rows cost what THOSE rows cost.
  let low = 0;
  let high = draft.rows.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sampledSheet(draft, total, mid).length <= allowance) low = mid;
    else high = mid - 1;
  }

  // And the search assumes a monotonic cost it cannot prove, so the result is checked
  // rather than trusted: shrinking geometrically converges without walking every row.
  let keep = low;
  let text = sampledSheet(draft, total, keep);
  while (keep > 0 && text.length > allowance) {
    keep = Math.floor(keep * 0.9);
    text = sampledSheet(draft, total, keep);
  }
  return text;
}

function wholeSheet(draft: SheetDraft, total: number): string {
  return sheetText(
    draft,
    total,
    draft.rows.map((_unused, index) => index),
  );
}

function sampledSheet(draft: SheetDraft, total: number, keep: number): string {
  return sheetText(draft, total, sampleIndices(draft.rows.length, keep));
}

function sheetText(draft: SheetDraft, total: number, kept: readonly number[]): string {
  const sampled = kept.length < draft.rows.length;
  const title = draft.name || `Hoja ${draft.position}`;
  const shape = `${draft.rows.length} fila(s) × ${draft.columns} columna(s)`;
  const header = `Hoja ${draft.position}/${total} «${title}» (${shape}${
    sampled ? `; MUESTRA de ${kept.length} fila(s)` : ""
  }):`;
  const body = kept.map((index) => draft.rows[index]!).join("\n");
  const notice = sampled ? sampledRowsNotice(kept, draft.rows.length) : "";
  return body === "" ? `${header}${notice}` : `${header}\n${body}${notice}`;
}

/**
 * What a cut says about itself (#865, #1419). The lesson that made this loud is older
 * than the sampling: a timid «(y 31 fila(s) más)» read as decoration, and a 91-row
 * movements sheet cut at row 60 had the model present «04/04/2026, saldo 4,51 €» as
 * the document's closing balance — three months and 54 € from the truth.
 *
 * A sample cannot lie that way, because the last row IS in it. What it CAN be misread
 * as is a continuous table — «hay 120 movimientos», «suman X» — so that is what this
 * text denies, and it states which of the two facts holds rather than asserting the
 * comfortable one: with a single row kept there is no tail, and claiming otherwise
 * would be the same failure in a smaller size.
 *
 * These lines are generated HERE, by code, and land inside the document's own fence —
 * so a hostile sheet can print a lookalike. That direction is harmless (a forged notice
 * only claims a cut that did not happen), and the direction that would matter —
 * convincing the model nothing was cut — is not available to it: the RULE lives in the
 * framing, outside the fence, where `neutralizeFence` guarantees the document cannot
 * forge our markers (`attachment-chat.ts`).
 */
function sampledRowsNotice(kept: readonly number[], total: number): string {
  if (kept.length === 0) {
    return `\n(ATENCIÓN, LECTURA PARCIAL: de las ${total} filas de esta hoja no cabe ninguna en el espacio disponible. El documento CONTINÚA más allá de lo visible.)`;
  }
  const closes = kept[kept.length - 1] === total - 1;
  const ending = closes
    ? "La última fila mostrada SÍ es la última de la hoja."
    : "El documento CONTINÚA más allá de la última fila mostrada.";
  return `\n(ATENCIÓN, LECTURA PARCIAL: de las ${total} filas de esta hoja se muestran ${kept.length} como MUESTRA — las primeras, las últimas y un paso regular por el medio. Las filas visibles NO son consecutivas: entre dos de ellas faltan otras, así que no cuentes filas ni deduzcas totales, medias ni frecuencias de lo que ves. ${ending})`;
}

function droppedSheetsNotice(shown: number, total: number): string {
  return `${SHEET_SEPARATOR}(ATENCIÓN, LECTURA PARCIAL: se muestran ${shown} de ${total} hojas; ${total - shown} no caben en el espacio disponible. El documento CONTINÚA más allá de lo visible.)`;
}

/**
 * Which rows survive a sample of `keep` out of `total`: the head, the tail, and a
 * regular step through everything between them.
 *
 * The head carries the header row and the opening of the series, the tail carries where
 * it stands today, and the step is what makes the middle a sample rather than a gap —
 * a reader can see the shape of a thirty-year table from a hundred rows spread across
 * it, and can see nothing at all from its first five years.
 */
function sampleIndices(total: number, keep: number): number[] {
  if (keep >= total) return Array.from({ length: total }, (_unused, index) => index);
  if (keep <= 0) return [];

  const head = Math.min(keep, Math.max(1, Math.round(keep * HEAD_SHARE)));
  const tail = Math.min(keep - head, Math.max(1, Math.round(keep * TAIL_SHARE)));
  const middle = keep - head - tail;
  // `keep < total` makes the interior strictly wider than the middle it must hold, so
  // the step below never lands twice on the same row.
  const span = total - head - tail;

  const indices = new Set<number>();
  for (let index = 0; index < head; index += 1) indices.add(index);
  for (let index = 0; index < tail; index += 1) indices.add(total - 1 - index);
  for (let index = 0; index < middle; index += 1) {
    indices.add(head + Math.floor((index * span) / middle));
  }
  return [...indices].sort((left, right) => left - right);
}
