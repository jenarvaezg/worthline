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
 * reporting what is missing. The dictated traspaso composes it the same way
 * ({@link ../typed-transfer}, #1794), which is why the operation's NAME is read here
 * too: a traspaso's paper says which half it confirms only in that cell.
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
  /**
   * What the paper calls the operation, as printed beside «Operación»: «REEMB.POR
   * TRASPASO I», «SUSCRIPCION I.I.C.» (#1794). Text, not a figure, and present only when
   * it was printed beside its label — see {@link TEXT_LABELS}.
   */
  operation?: string;
  /**
   * The figures read above whose decimal mark the block itself did not settle — see
   * {@link blockDecimalMark}. Each is reported as printed and was read the es-ES way, as
   * it always was; what to do about it is the caller's: the traspaso refuses naming it,
   * the dictated operation (#1751) keeps reading it as before. Absent when there is none.
   */
  unsettled?: UnsettledFigure[];
}

/** A figure whose point or comma could be the decimal or the thousands: «37.203». */
export interface UnsettledFigure {
  field: "amount" | "fees" | "price" | "units";
  /** The token as the paper printed it. */
  printed: string;
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

/**
 * A cell that prints a currency and NO figure — «EUR» under «Gastos» when there were
 * none, as the traspaso confirmation of #1794 does («0.00 EUR · EUR · 739.22 EUR»).
 *
 * It sits in the figures' row, so it is a VALUE, an empty one. Taken for a label it
 * made its row unequal, and the row dropped whole was the commission row: the one whose
 * reading decides whether the chat may write the traspaso at all.
 */
const EMPTY_FIGURE_CELL = /^(?:EUR|USD|GBP|CHF|€|\$|£)$/u;

/** A cell on the figures' side of the pairing: a figure, or an empty one. */
function isValueCell(cell: string): boolean {
  return FIGURE_CELL.test(cell) || EMPTY_FIGURE_CELL.test(cell);
}

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
 * The labels whose value is TEXT, not a figure (#1794): what the paper calls the
 * operation.
 *
 * They exist for the pairing, not for what they read. A traspaso's confirmation prints
 * «Operación · REEMB.POR TRASPASO I · Fecha Operación · Fecha Valor» and then the two
 * dates — and to the run-against-run pairing every one of those four cells is a label,
 * because none of them opens with a digit. Four labels against two dates is an unequal
 * run, dropped whole, and the day of the operation went with it. Knowing that
 * «Operación» carries its value beside it takes that pair out of the run, and the two
 * dates land on their own labels.
 */
const TEXT_LABELS: ReadonlySet<string> = new Set([
  "operacion",
  "tipo de operacion",
  "tipo operacion",
]);

/**
 * What a cell has to say to be taken as the value of a text label: the NAME of an
 * operation, normalised as {@link normalizeLabel} leaves it.
 *
 * Gated on the vocabulary, and not on «whatever cell comes next», because the next cell
 * is just as often the following column's header. Jose's paste of #1751 prints
 * «Operación · Referencia Operación» and only then the two values: a text label that
 * swallowed «Referencia Operación» would shift every cell after it one place left, and
 * a shifted run can come out EQUAL — a wrong figure on a right-looking label. A cell
 * that names no operation leaves the label in its run, exactly as before.
 */
const OPERATION_NAME =
  /\b(?:suscr\w*|reemb\w*|rescat\w*|traspas\w*|compra|venta|aportacion\w*)\b/u;

/** Whether `cell` is the name of an operation a text label can take as its value. */
function namesOperation(cell: string): boolean {
  if (isValueCell(cell)) return false;
  const label = normalizeLabel(cell);
  if (LABELS.has(label) || TEXT_LABELS.has(label)) return false;
  return OPERATION_NAME.test(label);
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
 *
 * A text label ({@link TEXT_LABELS}) is held back one cell: when the next cell names an
 * operation, the two are a pair of their own and join no run; when it does not, the
 * label goes into its run exactly where it would have gone before (#1794).
 */
function pairedCellsIn(text: string): { paired: PairedCell[]; operation?: string } {
  const paired: PairedCell[] = [];
  let labels: string[] = [];
  let figures: string[] = [];
  let textLabel: string | null = null;
  let operation: string | undefined;

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

  const pushLabel = (cell: string): void => {
    // A label after figures opens the NEXT row: the run that just closed is resolved.
    if (figures.length > 0) flush();
    labels.push(cell);
  };

  for (const row of text.split(ROW_BREAK)) {
    const cells = cellsIn(row);
    for (const [index, cell] of cells.entries()) {
      // The held-back text label is settled BEFORE this row's own break is honoured:
      // unclaimed, it belongs to the run it was printed in, not to the next row's.
      if (textLabel !== null) {
        const held = textLabel;
        textLabel = null;
        if (namesOperation(cell)) {
          flush();
          operation ??= cell;
          continue;
        }
        pushLabel(held);
      }
      // A row of labels following a row of labels is a section title, not a header: it
      // must not stack, or three columns of header would line up against two of
      // figures. A row that OPENS with a figure is the continuation of the header above
      // it, so the labels stay open across that break.
      if (index === 0 && !isValueCell(cell)) flush();
      if (isValueCell(cell)) {
        // A figure with no label run open belongs to nothing: close and start over.
        if (labels.length === 0) flush();
        else figures.push(cell);
        continue;
      }
      if (TEXT_LABELS.has(normalizeLabel(cell))) {
        textLabel = cell;
        continue;
      }
      pushLabel(cell);
    }
  }
  if (textLabel !== null) pushLabel(textLabel);
  flush();
  return { paired, ...(operation === undefined ? {} : { operation }) };
}

/** Which character a block writes its decimals with. */
type DecimalMark = "." | ",";

/**
 * A figure whose ONE separator is followed by exactly three digits: «37.203», «1,234».
 * Alone it cannot be read — thirty-seven participaciones and change, or thirty-seven
 * thousand — and participaciones are printed with three decimals all the time (#1794).
 */
const UNSETTLED_FIGURE = /^\d{1,3}[.,]\d{3}$/u;

/** What one printed figure says about the block's decimal mark, if anything. */
function decimalMarkOf(token: string): DecimalMark | null {
  if (UNSETTLED_FIGURE.test(token)) return null;
  // «739.22», «12.0003», «1,234.56»: a point no thousands grouping explains.
  if (/^\d+\.\d+$/u.test(token) || /^\d{1,3}(?:,\d{3})+\.\d+$/u.test(token)) return ".";
  if (/^\d+,\d+$/u.test(token) || /^\d{1,3}(?:\.\d{3})+,\d+$/u.test(token)) return ",";
  // «1.234.567»: two points can only group thousands, so the decimal is the comma.
  if (/^\d{1,3}(?:\.\d{3}){2,}$/u.test(token)) return ",";
  if (/^\d{1,3}(?:,\d{3}){2,}$/u.test(token)) return ".";
  return null;
}

/** The figures a cell prints, unsigned, as they appear once spaces are gone. */
function figureTokensIn(cell: string): string[] {
  return Array.from(cell.replace(/\s/gu, "").matchAll(/\d[\d.,]*\d|\d/gu), (m) => m[0]);
}

/**
 * The decimal mark this paste writes with, read off its OWN figures (#1794): a bank
 * prints one convention per paper, so «739.22 EUR» settles how «37.203» beside it is
 * read. `null` when nothing settles it — no figure says, or two say different things —
 * and then a figure that needs it is reported rather than guessed.
 */
function blockDecimalMark(text: string): DecimalMark | null {
  const marks = new Set(
    text
      .split(ROW_BREAK)
      .flatMap(cellsIn)
      .filter(isValueCell)
      .flatMap(figureTokensIn)
      .map(decimalMarkOf)
      .filter((mark): mark is DecimalMark => mark !== null),
  );
  return marks.size === 1 ? [...marks][0]! : null;
}

/** «37.203» read with `mark` as the decimal: either separator, either way. */
function readWithMark(unsigned: string, mark: DecimalMark): number {
  const separator = unsigned.includes(".") ? "." : ",";
  return Number(
    separator === mark
      ? unsigned.replace(separator, ".")
      : unsigned.replace(separator, ""),
  );
}

/** One figure a paired cell states, and whether its decimal mark went unsettled. */
interface CellFigure {
  value: number;
  printed: string;
  unsettled: boolean;
}

/**
 * The first figure a paired cell states, or `null` when the cell states none.
 *
 * `1.51`, `42.7996 EUR`, `64,62 €`, `-1,50 EUR`. A date cell («01/09/2026») deliberately
 * yields nothing here: it is read by {@link dateTokenIn}, which knows what a real day is.
 *
 * A figure like «37.203» is read with the block's own mark when it has one (#1794).
 * When it has none it is read the es-ES way, as it always was, and flagged — unless both
 * readings agree («0.000»), in which case there was nothing to settle.
 */
function figureIn(cell: string, mark: DecimalMark | null): CellFigure | null {
  const found = /-?\d[\d.,]*/u.exec(cell.replace(/\s/gu, ""));
  if (found === null) return null;
  const printed = found[0];
  const unsigned = printed.replace(/^-/u, "");
  if (!UNSETTLED_FIGURE.test(unsigned)) {
    const value = normalizeExtractedNumber(printed);
    return value === null ? null : { printed, unsettled: false, value };
  }
  const sign = printed.startsWith("-") ? -1 : 1;
  if (mark !== null) {
    return { printed, unsettled: false, value: sign * readWithMark(unsigned, mark) };
  }
  const value = normalizeExtractedNumber(printed);
  if (value === null) return null;
  const readings = new Set([readWithMark(unsigned, "."), readWithMark(unsigned, ",")]);
  return { printed, unsettled: readings.size > 1, value };
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
  // The operation's name does not count towards the threshold: it is text, and what
  // makes a paste a confirmation is figures paired with their labels.
  const { operation, paired } = pairedCellsIn(text);
  if (paired.length < RECEIPT_THRESHOLD) return null;

  const mark = blockDecimalMark(text);
  let gross: CellFigure | undefined;
  let net: CellFigure | undefined;
  let units: CellFigure | undefined;
  let price: CellFigure | undefined;
  let executedAt: string | undefined;
  const costs: CellFigure[] = [];

  for (const { field, value } of paired) {
    if (field === "date") {
      // Only the FIRST «Fecha Operación» is read, and «Fecha Valor» is not a label at
      // all: the day an operation is written with is the day it was executed, never the
      // day it settled. Reading the second would date every purchase one day late.
      executedAt ??= dateTokenIn(value)?.day ?? undefined;
      continue;
    }
    const figure = figureIn(value, mark);
    if (figure === null) continue;
    if (field === COST_LABELS) costs.push(figure);
    else if (field === "units") units ??= figure.value > 0 ? figure : undefined;
    else if (field === "price") price ??= figure;
    else if (field === "amount_gross") gross ??= figure;
    else net ??= figure;
  }

  const fees =
    costs.length > 0
      ? roundToCent(costs.reduce((sum, cost) => sum + cost.value, 0))
      : undefined;
  const amount = amountIn(gross?.value, net?.value, fees ?? 0);
  // The importe stands on the gross plus the costs when there is a gross, and on the
  // efectivo otherwise: a figure is unsettled for it only if it is one it stands on.
  const unsettled: UnsettledFigure[] = [
    ...unsettledAs("units", units),
    ...unsettledAs("price", price),
    ...unsettledAs("amount", gross ?? net),
    ...costs.flatMap((cost) => unsettledAs("fees", cost)),
  ];
  return {
    ...(units === undefined ? {} : { units: String(units.value) }),
    ...(amount === undefined ? {} : { amount }),
    ...(price === undefined ? {} : { pricePerUnit: price.value }),
    ...(fees === undefined ? {} : { fees }),
    ...(executedAt === undefined ? {} : { executedAt }),
    ...(operation === undefined ? {} : { operation }),
    ...(unsettled.length === 0 ? {} : { unsettled }),
  };
}

function unsettledAs(
  field: UnsettledFigure["field"],
  figure: CellFigure | undefined,
): UnsettledFigure[] {
  return figure?.unsettled ? [{ field, printed: figure.printed }] : [];
}
