/**
 * The rows of MyInvestor's first start and what ticking them adds up to (#1880).
 * Client-safe on purpose: the fold's island recomputes the panel «Así queda tu
 * patrimonio» as boxes are ticked, so this module imports no adapter and no store,
 * only types. The rows themselves are built server-side by `myinvestor-first-start.ts`.
 */
import type { DecimalString } from "@worthline/domain";
import type {
  MyInvestorDiscoveredAccount,
  MyInvestorProductKind,
} from "./myinvestor-discovery";

/** Where a product lands in the patrimonio. */
export type MyInvestorRung = "liquid" | "invested" | "retirement";

export const MYINVESTOR_RUNG_LABEL: Record<MyInvestorRung, string> = {
  invested: "Invertido",
  liquid: "Líquido",
  retirement: "Jubilación",
};

export const MYINVESTOR_KIND_LABEL: Record<MyInvestorProductKind, string> = {
  cash: "Efectivo",
  etf: "ETF",
  fund: "Fondo",
  managed: "Cartera gestionada",
  plan: "Plan de pensiones",
  stock: "Acción",
};

/** Why a product cannot be included in this slice; each one is another slice's. */
export type MyInvestorInclusionBlock =
  /** The robo-advisor's account links as one block: portfolio, funds and cash (#1883). */
  | { readonly reason: "managed_portfolio" }
  /** A manual holding already has its identifier: creating it apart would duplicate it (#1881). */
  | { readonly reason: "manual_twin"; readonly holdingName: string }
  /** An operation in another currency: the holding would sum two currencies (#1401). */
  | { readonly reason: "currency" };

export interface MyInvestorProductRow {
  readonly key: string;
  readonly accountKey: string;
  readonly name: string;
  readonly kind: MyInvestorProductKind;
  readonly identifier: string | null;
  readonly units: DecimalString | null;
  /** What the holding is worth in worthline the day it is created: its cost until priced. */
  readonly valueMinor: number;
  readonly rung: MyInvestorRung;
  readonly operations: number;
  /** The first operation's day, `YYYY-MM-DD`; null for cash and a managed portfolio. */
  readonly since: string | null;
  /** Held for orders in progress, already inside the balance (P4); null when none. */
  readonly withheldMinor: number | null;
  readonly otherHolder: boolean;
  /** It came in from another institution: the inherited cost is asked later (#1882). */
  readonly inheritedCostPending: boolean;
  readonly members: readonly string[];
  readonly block: MyInvestorInclusionBlock | null;
  /** Already a linked holding. */
  readonly linked: boolean;
  /** Ticked when the fold opens: what is the user's and holds something today. */
  readonly selectedByDefault: boolean;
}

export interface MyInvestorAccountGroup {
  readonly account: MyInvestorDiscoveredAccount;
  readonly products: readonly MyInvestorProductRow[];
}

export interface MyInvestorFirstStartView {
  readonly readOn: string;
  /** The user's own accounts, in the bank's order. */
  readonly own: readonly MyInvestorAccountGroup[];
  /** Someone else's, at the end, unticked (#1869 P3). */
  readonly others: readonly MyInvestorAccountGroup[];
  readonly rows: readonly MyInvestorProductRow[];
}

/** Whether a row can be ticked: not linked yet, and not another slice's. */
export function isIncludable(row: MyInvestorProductRow): boolean {
  return !row.linked && row.block === null;
}

export interface MyInvestorSelectionSummary {
  readonly count: number;
  readonly operations: number;
  readonly valueMinor: number;
  readonly byRung: Readonly<Record<MyInvestorRung, number>>;
  /** Entries whose inherited cost will be asked (#1882). */
  readonly pendingCost: number;
  /** Products already kept by hand, left out until #1881 can review them. */
  readonly twins: number;
}

/** What including the ticked rows adds to the patrimonio. Pure; the panel's figures. */
export function summarizeMyInvestorSelection(
  rows: readonly MyInvestorProductRow[],
  selected: ReadonlySet<string>,
): MyInvestorSelectionSummary {
  const chosen = rows.filter((row) => selected.has(row.key) && isIncludable(row));
  const byRung: Record<MyInvestorRung, number> = {
    invested: 0,
    liquid: 0,
    retirement: 0,
  };
  for (const row of chosen) byRung[row.rung] += row.valueMinor;
  return {
    byRung,
    count: chosen.length,
    operations: chosen.reduce((sum, row) => sum + row.operations, 0),
    pendingCost: chosen.filter((row) => row.inheritedCostPending).length,
    twins: rows.filter((row) => row.block?.reason === "manual_twin" && !row.linked)
      .length,
    valueMinor: chosen.reduce((sum, row) => sum + row.valueMinor, 0),
  };
}

/** Tick or untick one product. Pure: a new set, the old one untouched. */
export function toggleMyInvestorSelection(
  selected: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Tick or untick every product of a group at once, from its group box. */
export function setMyInvestorSelection(
  selected: ReadonlySet<string>,
  keys: readonly string[],
  on: boolean,
): ReadonlySet<string> {
  const next = new Set(selected);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

/**
 * What a group box shows: all of its includable products ticked, none, or some (the
 * mixed state). A group with nothing includable reads as none.
 */
export function myInvestorGroupState(
  includableKeys: readonly string[],
  selected: ReadonlySet<string>,
): "all" | "none" | "mixed" {
  const on = includableKeys.filter((key) => selected.has(key)).length;
  if (includableKeys.length === 0 || on === 0) return "none";
  return on === includableKeys.length ? "all" : "mixed";
}
