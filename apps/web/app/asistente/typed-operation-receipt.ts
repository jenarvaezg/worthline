/**
 * The JUSTIFICANTE a user PASTES as text, read by its own labels (#1751).
 *
 * The typed door of #1466 reads prose — «he comprado 6 participaciones de IE00B43VDT70
 * por 312,55 €» — by making each figure wear its own word, and it refuses when two
 * figures could be the importe, because order is not evidence. That rule is right for
 * prose and exactly wrong for the thing users actually have at hand: the bank's own
 * confirmation, copied and pasted. Jose pasted one and got «en tu mensaje hay más de una
 * cifra en euros y no sé cuál es el importe», because the paper prints ten of them
 * (bruto, efectivo, tres ceros de comisiones, tipo de cambio…).
 *
 * So the paste is rejected for carrying MORE information, not less — and the most
 * trustworthy information a person can type, since they did not type it at all: they
 * copied it. The answer is the doctrine of #1418 one more time: **to let pasted figures
 * in, parse them**. No model reads this paper either; worthline does.
 *
 * WHAT MAKES IT READABLE, and it is not «etiqueta: valor»: a confirmation is a TABLE
 * flattened into text, so its labels arrive in a row and their figures in the next one,
 * matched by POSITION:
 *
 *     Número de títulos/Participaciones   Precio Bruto   Importe Bruto
 *     1.51                                42.7996 EUR    64.62 EUR
 *
 * The one thing that survives the flattening is the column gap — two or more spaces, a
 * tab, a newline. So this module cuts the paste into CELLS on that gap, groups
 * consecutive label cells and consecutive figure cells, and pairs a run of k labels with
 * the run of k figures that follows it. Unequal runs are dropped whole rather than
 * aligned by guesswork: a mispaired figure is a wrong write, and the gap message asking
 * for the number again costs nothing.
 *
 * That is also why unknown labels are still LABELS and not noise. «Retención Origen ·
 * Retención Destino · Importe Efectivo Neto (1) · Tipo de Cambio» pairs four with four,
 * and only the third is read — but drop the three we do not care about and the fourth
 * figure lands on the wrong word.
 *
 * Pure and I/O-free. Returns figures, never an event: composing one — with the ISIN, the
 * currency and the direction read off the whole message — stays with
 * {@link ../typed-holding-event}, so a paste and a dictated sentence keep ONE way of
 * reporting what is missing.
 */

import { normalizeExtractedNumber } from "./attachment-extraction-contract";
import { dateTokenIn } from "./typed-message-reading";

/** The figures a pasted confirmation states, each one read off its own label. */
export interface OperationReceiptFigures {
  /** Participaciones as a decimal string, from «Número de títulos» and its synonyms. */
  units?: string;
  /** The total importe in major units, commissions included. See {@link amountIn}. */
  amount?: number;
  /** The unit price the paper prints, in major units. */
  pricePerUnit?: number;
  /** What the operation cost on top of the gross amount, summed. See {@link COST_LABELS}. */
  fees?: number;
  /** The day of «Fecha Operación» — never «Fecha Valor». */
  executedAt?: string;
}

/**
 * The labels this reader knows, normalised. Everything else is still a label for the
 * pairing (see the module note) and simply reads nothing.
 *
 * Deliberately a table of EXACT normalised cells and not a substring search: the last
 * line of Jose's paste is «(1) El Importe Neto ha sido anotado en su cuenta corriente en
 * la fecha indicada», and a reader matching «importe neto» anywhere would take that
 * sentence for a label and start pairing prose with figures.
 */
type ReceiptField = "amount_gross" | "amount_net" | "cost" | "date" | "price" | "units";

const LABELS: ReadonlyMap<string, ReceiptField> = new Map([
  ["numero de titulos", "units"],
  ["numero de titulos/participaciones", "units"],
  ["numero de participaciones", "units"],
  ["n de titulos", "units"],
  ["n de participaciones", "units"],
  ["titulos", "units"],
  ["titulos/participaciones", "units"],
  ["participaciones", "units"],
  ["acciones", "units"],
  ["cantidad", "units"],
  ["precio", "price"],
  ["precio bruto", "price"],
  ["precio unitario", "price"],
  ["precio por titulo", "price"],
  ["precio por participacion", "price"],
  ["valor liquidativo", "price"],
  ["cambio", "price"],
  ["importe bruto", "amount_gross"],
  ["efectivo bruto", "amount_gross"],
  ["bruto", "amount_gross"],
  ["importe", "amount_net"],
  ["importe neto", "amount_net"],
  ["importe efectivo", "amount_net"],
  ["importe efectivo neto", "amount_net"],
  ["importe total", "amount_net"],
  ["efectivo", "amount_net"],
  ["liquido", "amount_net"],
  ["comisiones", "cost"],
  ["comision", "cost"],
  ["gastos", "cost"],
  ["corretaje", "cost"],
  ["tasas e impuestos", "cost"],
  ["canon de bolsa", "cost"],
  ["fecha operacion", "date"],
  ["fecha de operacion", "date"],
  ["fecha de la operacion", "date"],
  ["fecha ejecucion", "date"],
  ["fecha de ejecucion", "date"],
]);

/**
 * Which labels add up into `fees`.
 *
 * Commissions, gastos and corretaje are the operation's cost without argument. «Tasas e
 * impuestos» joins them because on a securities order that line is the tasa de la
 * operación (the Spanish FTT among them), which IS part of what the trade cost. What
 * stays OUT is anything withheld on income — «Retención Origen», «Retención Destino» —
 * which is not a cost of the operation and would net a tax off the price of a share.
 * Those are unknown labels here, so they read as nothing, which is the point.
 */
const COST_LABELS: ReceiptField = "cost";

/**
 * How many labels have to pair with figures before a paste counts as a confirmation.
 *
 * Two, and not one: a single «Importe: 312,55 €» inside an otherwise dictated sentence
 * is prose, and it belongs to the reader that understands the rest of that sentence. Two
 * paired labels is a table, and a table is what this module exists for.
 */
const RECEIPT_THRESHOLD = 2;

/**
 * The column gap a flattened table keeps: two or more spaces, or a tab.
 *
 * A single space is NOT a separator — «Importe Efectivo Neto» is one cell — and that
 * asymmetry is the whole reading. A paste that lost its gaps entirely (everything
 * single-spaced) reads as one cell and yields nothing, which is honest: there is no
 * table left in it.
 */
const CELL_GAP = /\s{2,}|\t+/u;

/** The row break, when the paste still has one. See {@link pairedCellsIn}. */
const ROW_BREAK = /\r?\n/u;

/** A cell that states a figure: it opens with a digit. */
const FIGURE_CELL = /^[-+]?\s*\d/u;

/** A footnote marker a label carries — «Importe Efectivo Neto (1)». */
const FOOTNOTE = /\(\s*\d+\s*\)/gu;

/** Diacritics off, punctuation off, one space between words: the key `LABELS` uses. */
function normalizeLabel(cell: string): string {
  return cell
    .replace(FOOTNOTE, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[.·•*]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The paste cut into cells.
 *
 * A cell is split once more on `:` because plenty of confirmations print the pair inline
 * — «Código ISIN: IE0007987708», «Importe: 312,55 €» — and that colon is the same column
 * gap wearing other clothes. Splitting a cell that holds no label is harmless: both
 * halves keep their own kind.
 */
function cellsIn(text: string): string[] {
  return text
    .split(CELL_GAP)
    .flatMap((cell) => cell.split(":"))
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

/** One label paired with the cell that carries its figure. */
interface PairedCell {
  field: ReceiptField;
  value: string;
}

/**
 * Every label this paste pairs with a figure, in printed order.
 *
 * The pairing is run against run, k against k, and an unequal pair is dropped WHOLE —
 * see the module note. A run of figures with no labels before it (the account number at
 * the top, a reference) simply closes the previous run and is never read.
 *
 * Rows are honoured when the paste still HAS them, and dropped-whole is why: a paste
 * that kept its newlines prints section titles on their own line, and letting those
 * stack onto the header below would make every real row unequal and unreadable. A paste
 * that lost them — Jose's, one long line — is read by the runs alone, which is what the
 * module note describes.
 */
function pairedCellsIn(text: string): PairedCell[] {
  const paired: PairedCell[] = [];
  let labels: string[] = [];
  let figures: string[] = [];

  const flush = (): void => {
    if (labels.length > 0 && labels.length === figures.length) {
      for (const [index, label] of labels.entries()) {
        const field = LABELS.get(normalizeLabel(label));
        if (field !== undefined) paired.push({ field, value: figures[index]! });
      }
    }
    labels = [];
    figures = [];
  };

  for (const row of text.split(ROW_BREAK)) {
    const cells = cellsIn(row);
    // A row of labels following a row of labels is a section title, not a header: it
    // must not stack, or three columns of header would line up against two of figures.
    // A row that OPENS with a figure is the continuation of the header above it, so the
    // labels stay open across that break.
    if (cells.length > 0 && !FIGURE_CELL.test(cells[0]!)) flush();
    for (const cell of cells) {
      if (FIGURE_CELL.test(cell)) {
        // A figure with no label run open belongs to nothing: close and start over.
        if (labels.length === 0) flush();
        else figures.push(cell);
        continue;
      }
      // A label after figures opens the NEXT row: the run that just closed is resolved.
      if (figures.length > 0) flush();
      labels.push(cell);
    }
  }
  flush();
  return paired;
}

/**
 * The first figure a paired cell states, or `null` when the cell states none.
 *
 * `1.51`, `42.7996 EUR`, `64,62 €`, `-1,50 EUR`. A date cell («01/09/2026») deliberately
 * yields nothing here: it is read by {@link dateTokenIn}, which knows what a real day is.
 */
function figureIn(cell: string): number | null {
  const found = /-?\d[\d.,]*/u.exec(cell.replace(/\s/gu, ""));
  return found === null ? null : normalizeExtractedNumber(found[0]);
}

/**
 * The importe the operation is anchored on: the GROSS amount plus what it cost.
 *
 * Not the printed «efectivo», even when the paper prints one, and the reason is that
 * `resolveOperationTerms` reads `amount` as gross-plus-fees on both directions
 * (`netMinor = amount − fees`, and the printed price is cross-checked against that net).
 * On a purchase the two readings coincide; on a SALE the efectivo is gross MINUS the
 * commission, so taking it would net the fee twice and quietly move the price per share.
 * Reconstructing it from the gross keeps one meaning for `amount` on both.
 *
 * With no gross printed, the efectivo is all there is and the fees are the ones read —
 * which is the purchase case, and it adds up.
 */
function amountIn(
  gross: number | undefined,
  net: number | undefined,
  fees: number,
): number | undefined {
  if (gross !== undefined) return roundToCent(gross + fees);
  return net;
}

/** Cents, exactly: the sum above must not inherit a float tail. */
function roundToCent(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * The figures a pasted confirmation states, or `null` when this text is not one.
 *
 * `null` is the door back to the prose reader: everything about a message that is not a
 * table stays exactly as #1466 left it.
 */
export function operationReceiptFigures(text: string): OperationReceiptFigures | null {
  const paired = pairedCellsIn(text);
  if (paired.length < RECEIPT_THRESHOLD) return null;

  let gross: number | undefined;
  let net: number | undefined;
  let units: string | undefined;
  let pricePerUnit: number | undefined;
  let executedAt: string | undefined;
  let costs = 0;
  let anyCost = false;

  for (const { field, value } of paired) {
    if (field === "date") {
      // Only the FIRST «Fecha Operación» is read, and «Fecha Valor» is not a label at
      // all: the day an operation is written with is the day it was executed, never the
      // day it settled. Reading the second would date every purchase one day late.
      executedAt ??= dateTokenIn(value)?.day ?? undefined;
      continue;
    }
    const figure = figureIn(value);
    if (figure === null) continue;
    if (field === COST_LABELS) {
      costs += figure;
      anyCost = true;
      continue;
    }
    if (field === "units") units ??= figure > 0 ? String(figure) : undefined;
    else if (field === "price") pricePerUnit ??= figure;
    else if (field === "amount_gross") gross ??= figure;
    else net ??= figure;
  }

  const fees = anyCost ? roundToCent(costs) : undefined;
  const amount = amountIn(gross, net, fees ?? 0);
  return {
    ...(units === undefined ? {} : { units }),
    ...(amount === undefined ? {} : { amount }),
    ...(pricePerUnit === undefined ? {} : { pricePerUnit }),
    ...(fees === undefined ? {} : { fees }),
    ...(executedAt === undefined ? {} : { executedAt }),
  };
}
