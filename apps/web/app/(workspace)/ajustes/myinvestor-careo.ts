/**
 * The careo of ONE holding before a source that owns it replaces its manual
 * operations (#1881, design C; #1869 P3 and P6). Pure and per holding on purpose: the
 * first start uses it for each product with a manual twin, and the managed portfolio
 * (#1883) will use it for each member.
 *
 * - **Pairing is exact**: the same day, the same direction, the same amount (units ×
 *   price, to the cent) and the same units. It never guesses. A row that leaves and
 *   one that enters, alike but for a day a few days apart, only carry a hint: «igual
 *   que la del …: revisa la fecha».
 * - **The cost** before and after is worthline's moving average of each ledger
 *   (`derivePosition`), never FIFO and never the source's figure.
 * - **The value it adds**: the holding keeps its prices, so the difference is what
 *   `deriveInvestmentValuation` — the one engine that values it after the write —
 *   says of each ledger with the same cached and hand-set price: at a price, the
 *   units' difference; with none, the cost's.
 * - **The plan**: what `closeContributionPlanOnLink` will do, the same function the
 *   command applies (ADR 0115 decision 5).
 */
import type {
  ContributionCadence,
  ContributionOccurrenceReconciliation,
  DecimalString,
  InvestmentOperation,
  OperationKind,
  PlannedContribution,
  PlannedContributionAmount,
} from "@worthline/domain";
import {
  averageUnitCost,
  closeContributionPlanOnLink,
  deriveInvestmentValuation,
  derivePosition,
  multiplyToMinor,
  normalizeDecimal,
} from "@worthline/domain";

export type MyInvestorCareoMark = "same" | "leaves" | "enters";

export interface MyInvestorCareoRow {
  readonly mark: MyInvestorCareoMark;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly kind: OperationKind;
  readonly amountMinor: number;
  readonly units: DecimalString;
  /** The day of an alike row on the other side, a few days away: only a hint. */
  readonly near: string | null;
}

export interface MyInvestorCareoSide {
  readonly units: DecimalString;
  readonly costMinor: number;
  readonly averageMinor: number;
}

export interface MyInvestorCareoPlan {
  /** The lines that close today (a line not started yet is removed with them). */
  readonly lines: readonly {
    readonly amount: PlannedContributionAmount;
    readonly cadence: ContributionCadence;
  }[];
  /** Occurrences up to today still pending, which leave the pending list. */
  readonly pending: number;
}

export interface MyInvestorCareo {
  readonly rows: readonly MyInvestorCareoRow[];
  readonly counts: {
    readonly manual: number;
    readonly same: number;
    readonly leaves: number;
    readonly enters: number;
  };
  readonly before: MyInvestorCareoSide;
  readonly after: MyInvestorCareoSide;
  /** What linking adds to the patrimonio: the difference, never the whole value. */
  readonly valueDeltaMinor: number;
  readonly plan: MyInvestorCareoPlan | null;
}

export interface MyInvestorCareoInput {
  manual: readonly InvestmentOperation[];
  /** The source's rows for the product, as the batch would write them. */
  source: readonly InvestmentOperation[];
  /** The holding's usable cached quote, as its valuation reads it; absent when none. */
  cachedPrice?: DecimalString;
  /** The holding's hand-set price; absent when none. */
  manualPrice?: DecimalString;
  /** The holding's contribution plan, in any scope; null when it has none. */
  plan: {
    contributions: readonly PlannedContribution[];
    reconciliations: readonly ContributionOccurrenceReconciliation[];
  } | null;
  today: string;
}

/** How many days apart an alike pair may be and still earn the hint. */
const NEAR_DAYS = 7;
const DAY_MS = 86_400_000;
const MARK_ORDER: Record<MyInvestorCareoMark, number> = { enters: 2, leaves: 1, same: 0 };

function isIncoming(kind: OperationKind): boolean {
  return kind === "buy" || kind === "transfer_in";
}

function rowOf(operation: InvestmentOperation, mark: MyInvestorCareoMark) {
  return {
    amountMinor: multiplyToMinor(operation.units, operation.pricePerUnit),
    date: operation.executedAt.slice(0, 10),
    kind: operation.kind,
    mark,
    near: null as string | null,
    units: normalizeDecimal(operation.units),
  };
}

type MutableRow = ReturnType<typeof rowOf>;

function matchKey(row: MutableRow): string {
  return `${row.date}|${isIncoming(row.kind) ? "in" : "out"}|${row.amountMinor}|${row.units}`;
}

function sideOf(operations: readonly InvestmentOperation[]): MyInvestorCareoSide {
  const position = derivePosition([...operations], { assetId: "careo", currency: "EUR" });
  const costMinor = position.costBasis.amountMinor;
  return {
    averageMinor: multiplyToMinor(
      averageUnitCost(costMinor, position.currentUnits, 2),
      "1",
    ),
    costMinor,
    units: normalizeDecimal(position.currentUnits),
  };
}

function daysApart(left: string, right: string): number {
  return Math.abs(Date.parse(left) - Date.parse(right)) / DAY_MS;
}

/** Pair a leaving row with the closest entering one alike in amount and units. */
function hintNearDays(rows: MutableRow[]): void {
  const entering = rows.filter((row) => row.mark === "enters");
  for (const leaving of rows.filter((row) => row.mark === "leaves")) {
    let best: MutableRow | null = null;
    for (const candidate of entering) {
      if (candidate.near !== null) continue;
      if (
        candidate.amountMinor !== leaving.amountMinor ||
        candidate.units !== leaving.units ||
        isIncoming(candidate.kind) !== isIncoming(leaving.kind)
      ) {
        continue;
      }
      const distance = daysApart(candidate.date, leaving.date);
      if (distance > NEAR_DAYS) continue;
      if (best === null || distance < daysApart(best.date, leaving.date)) {
        best = candidate;
      }
    }
    if (best !== null) {
      best.near = leaving.date;
      leaving.near = best.date;
    }
  }
}

function planOf(
  plan: MyInvestorCareoInput["plan"],
  today: string,
): MyInvestorCareoPlan | null {
  if (plan === null || plan.contributions.length === 0) return null;
  const closing = closeContributionPlanOnLink({ ...plan, today });
  const touched = new Set([...closing.close.map((line) => line.id), ...closing.remove]);
  const lines = plan.contributions
    .filter((line) => touched.has(line.id))
    .map((line) => ({ amount: line.amount, cadence: line.cadence }));
  if (lines.length === 0 && closing.skip.length === 0) return null;
  return { lines, pending: closing.skip.length };
}

export function myInvestorCareo(input: MyInvestorCareoInput): MyInvestorCareo {
  // Each source row pairs with at most one manual row: a multiset, so two identical
  // buys on one day pair one to one.
  const waiting = new Map<string, number>();
  const sourceRows = input.source.map((operation) => rowOf(operation, "enters"));
  for (const row of sourceRows) {
    const key = matchKey(row);
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
  }
  const rows: MutableRow[] = [];
  const paired = new Map<string, number>();
  for (const operation of input.manual) {
    const row = rowOf(operation, "leaves");
    const key = matchKey(row);
    const left = waiting.get(key) ?? 0;
    if (left > 0) {
      waiting.set(key, left - 1);
      paired.set(key, (paired.get(key) ?? 0) + 1);
      rows.push({ ...row, mark: "same" });
    } else {
      rows.push(row);
    }
  }
  for (const row of sourceRows) {
    const key = matchKey(row);
    const already = paired.get(key) ?? 0;
    if (already > 0) {
      paired.set(key, already - 1);
      continue;
    }
    rows.push(row);
  }
  hintNearDays(rows);
  rows.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      MARK_ORDER[left.mark] - MARK_ORDER[right.mark],
  );

  const before = sideOf(input.manual);
  const after = sideOf(input.source);
  const valueOf = (operations: readonly InvestmentOperation[]) =>
    deriveInvestmentValuation({
      assetId: "careo",
      cachedPrice: input.cachedPrice,
      currency: "EUR",
      manualPrice: input.manualPrice,
      operations: [...operations],
    }).valueMinor;
  const valueDeltaMinor = valueOf(input.source) - valueOf(input.manual);

  return {
    after,
    before,
    counts: {
      enters: rows.filter((row) => row.mark === "enters").length,
      leaves: rows.filter((row) => row.mark === "leaves").length,
      manual: input.manual.length,
      same: rows.filter((row) => row.mark === "same").length,
    },
    plan: planOf(input.plan, input.today),
    rows,
    valueDeltaMinor,
  };
}

/** Words that name what a product IS, not which one: they never make two alike. */
const GENERIC_WORDS = new Set([
  "acc",
  "accumulation",
  "and",
  "class",
  "clase",
  "cubierto",
  "del",
  "dis",
  "dist",
  "distribution",
  "etf",
  "eur",
  "euro",
  "fondo",
  "fondos",
  "fund",
  "funds",
  "hedged",
  "inc",
  "index",
  "indice",
  "isin",
  "las",
  "los",
  "mano",
  "pensiones",
  "plan",
  "sicav",
  "sin",
  "the",
  "ucits",
  "usd",
]);

function distinctiveWords(name: string): Set<string> {
  return new Set(
    name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !GENERIC_WORDS.has(word)),
  );
}

/**
 * Whether two names look like the same product: at least two distinctive words in
 * common. Only a SUGGESTION ever comes of it (#1881): it never links on its own.
 */
export function myInvestorNamesAlike(left: string, right: string): boolean {
  const words = distinctiveWords(left);
  let shared = 0;
  for (const word of distinctiveWords(right)) if (words.has(word)) shared += 1;
  return shared >= 2;
}
