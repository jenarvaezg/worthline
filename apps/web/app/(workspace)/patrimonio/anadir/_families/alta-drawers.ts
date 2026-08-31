/**
 * The alta wizard's canonical disclosure table (#1700).
 *
 * The wizard reveals its panes with CSS only (ADR 0009): every pane is in the DOM
 * at once and a `:has(input:checked)` rule decides which one shows. That rule and
 * the pane it targets used to live hundreds of lines apart in the page — the
 * selector string in a `revealCss` array near the top, the `className` /
 * `data-*` literal down in the pane's JSX — with no type joining them. Renaming
 * a class broke the visibility in silence: nothing failed to compile, nothing
 * failed a test, the drawer simply never opened.
 *
 * So the correspondence is by construction here. This module owns:
 *
 * - the **tables**: which drawers exist, which investment groups, which capture
 *   modes, which debt kinds — plus the labels and hints each one shows;
 * - the **vocabulary**: every class name and data-attribute the disclosure uses,
 *   as constants;
 * - the **DOM props** each pane spreads onto its wrapper, and
 * - {@link altaRevealCss}, which generates the rules FROM the same tables and the
 *   same constants.
 *
 * A pane cannot name a class the CSS does not target, because it does not name a
 * class at all: it asks this module for its props. Adding a drawer is adding a row.
 */

import type { Instrument } from "@worthline/domain";

// ---------------------------------------------------------------------------
// The vocabulary: every literal the disclosure depends on, declared once
// ---------------------------------------------------------------------------

/** The form the `:has()` rules are scoped to. */
const FORM_CLASS = "simpleAdd";
/** The placeholder shown until a drawer is picked. */
const DRAWER_EMPTY_CLASS = "simpleAddEmpty";
const DRAWER_PANE_CLASS = "simpleDrawerPane";
const DRAWER_ATTR = "data-drawer";
/** The radio group that picks the drawer. */
export const DRAWER_FIELD = "simpleDrawer";

const GROUP_EMPTY_CLASS = "invGroupEmpty";
const GROUP_PANE_CLASS = "invGroupPane";
const GROUP_ATTR = "data-group";
/** The radio group that picks the investment group. Canonical: it IS the instrument. */
export const GROUP_FIELD = "instrument";

const MODE_PANE_CLASS = "invModePane";
const MODE_ATTR = "data-mode";
/** The radio group that picks the capture mode, scoped per investment group. */
export function modeField(instrument: InvestmentGroupInstrument): string {
  return `invMode_${instrument}`;
}

/** The radio group that picks the kind of debt. */
export const DEBT_KIND_FIELD = "simpleDebtKind";
/** The two debt blocks the kind hides, by role. */
const DEBT_BLOCK_CLASS = {
  balanceField: "debtSimpleBalanceField",
  currentStateBlock: "debtCurrentStateBlock",
} as const;

type DebtBlockRole = keyof typeof DEBT_BLOCK_CLASS;

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

export type DrawerId = "dinero" | "inversion" | "inmueble" | "bien" | "deuda";

export interface Drawer {
  id: DrawerId;
  label: string;
  hint: string;
  /** The tier token that colours the card's dot. */
  dot: string;
}

export const DRAWERS: readonly Drawer[] = [
  {
    id: "dinero",
    label: "Dinero",
    hint: "Cuentas, efectivo o un depósito a plazo.",
    dot: "var(--tier-cash)",
  },
  {
    id: "inversion",
    label: "Una inversión",
    hint: "Fondos, acciones, planes o cripto.",
    dot: "var(--tier-market)",
  },
  {
    id: "inmueble",
    label: "Un inmueble",
    hint: "Tu casa, un piso o un local.",
    dot: "var(--tier-housing)",
  },
  {
    id: "bien",
    label: "Otro bien",
    hint: "Coche, oro u otro objeto de valor.",
    dot: "var(--tier-illiquid)",
  },
  {
    id: "deuda",
    label: "Una deuda",
    hint: "Hipoteca, préstamo o tarjeta.",
    dot: "var(--debit-rule)",
  },
];

/** The instruments the three investment groups stand for. */
export type InvestmentGroupInstrument = Extract<
  Instrument,
  "fund" | "pension_plan" | "crypto"
>;

/**
 * The 3 behavior groups of «Una inversión» (#597): not the 6 fine instrument
 * labels, but the 3 that price differently. Bolsa maps to `fund` by default (the
 * fine ETF/acción/índice label is editable in the ficha — ADR 0014); the search
 * is scoped to each group's provider, which sidesteps cross-provider noise (#304).
 */
export interface InvestmentGroup {
  instrument: InvestmentGroupInstrument;
  label: string;
  hint: string;
  providerLabel: string;
  searchPlaceholder: string;
  symbolLabel: string;
  symbolHint?: string;
  /**
   * Whether this group's «tengo el extracto» pane also offers the ACCOUNT-level
   * import (PRD #669 S3, #674): the multi-ISIN engine creates fund investments,
   * so only the bolsa group can send the user there. Declared here rather than
   * re-asked as `instrument === "fund"` inside the pane.
   */
  accountLevelImport?: true;
}

export const INVESTMENT_GROUPS: readonly InvestmentGroup[] = [
  {
    instrument: "fund",
    label: "Cotiza en bolsa",
    hint: "Fondos, ETFs, acciones o índices.",
    providerLabel: "Yahoo Finance",
    searchPlaceholder: "MSCI World, IE00BYX5NX33…",
    symbolLabel: "Símbolo del proveedor",
    accountLevelImport: true,
  },
  {
    instrument: "pension_plan",
    label: "Plan de pensiones",
    hint: "Tu plan, por su código de Finect.",
    providerLabel: "Finect",
    searchPlaceholder: "N5394-Myinvestor",
    symbolLabel: "Código Finect",
  },
  {
    instrument: "crypto",
    label: "Cripto",
    hint: "Bitcoin, Ethereum y otras monedas.",
    providerLabel: "CoinGecko",
    searchPlaceholder: "bitcoin, ethereum…",
    symbolLabel: "Id de CoinGecko",
    symbolHint: "p. ej. «bitcoin»",
  },
];

/** How the user answers «cuánto tengo» for an investment. */
export type InvestmentModeId = "saldo" | "import" | "traspaso";

export interface InvestmentMode {
  id: InvestmentModeId;
  label: string;
  /** The `display` the revealed pane takes — its own layout, not a shared one. */
  display: "grid" | "block";
  /**
   * The mode a round-trip that brought nothing back reopens. Exactly one mode
   * carries it, and the radios read it as a NEGATIVE list on purpose: anything
   * unrecognised — absent, blank, a value from a future mode — falls back here.
   * A positive test would leave the group with NO radio checked, which is a form
   * that submits nothing.
   */
  isDefault?: true;
}

export const INVESTMENT_MODES: readonly InvestmentMode[] = [
  { id: "saldo", label: "Sé cuánto tengo hoy", display: "grid", isDefault: true },
  { id: "import", label: "Tengo el extracto del bróker", display: "block" },
  {
    id: "traspaso",
    label: "Viene traspasada de otra entidad",
    display: "grid",
  },
];

/** Whether a round-tripped `invMode` names a non-default mode. */
export function isNonDefaultInvestmentMode(value: string | undefined): boolean {
  return INVESTMENT_MODES.some((mode) => !mode.isDefault && mode.id === value);
}

/** The three debt instruments the wizard's «Tipo de deuda» radios stand for. */
export type DebtKindInstrument = Extract<Instrument, "mortgage" | "loan" | "credit_card">;

/**
 * The three kinds of debt the wizard offers, and which block each one hides.
 * «Alta por estado actual» (ADR 0056, #677) is the default path for hipoteca and
 * préstamo — so those hide the plain balance field; tarjeta (revolving) never
 * gets a plan, so it keeps the balance field and hides the current-state block.
 */
export interface DebtKind {
  id: DebtKindInstrument;
  label: string;
  hides: DebtBlockRole;
}

export const DEBT_KINDS: readonly DebtKind[] = [
  { id: "mortgage", label: "Hipoteca", hides: "balanceField" },
  { id: "loan", label: "Préstamo", hides: "balanceField" },
  { id: "credit_card", label: "Tarjeta", hides: "currentStateBlock" },
];

/** The kind a debt pane opens on when nothing was round-tripped. */
export const DEFAULT_DEBT_KIND: DebtKindInstrument = "mortgage";

// ---------------------------------------------------------------------------
// The DOM props — the other half of every selector below
// ---------------------------------------------------------------------------

/** The wrapper props of one drawer's pane. */
export function drawerPaneProps(
  drawer: DrawerId,
): { className: string } & Record<typeof DRAWER_ATTR, DrawerId> {
  return { className: DRAWER_PANE_CLASS, [DRAWER_ATTR]: drawer };
}

/** The wrapper props of one investment group's pane. */
export function groupPaneProps(
  group: InvestmentGroupInstrument,
): { className: string } & Record<typeof GROUP_ATTR, InvestmentGroupInstrument> {
  return { className: GROUP_PANE_CLASS, [GROUP_ATTR]: group };
}

/** The wrapper props of one capture mode's pane. */
export function modePaneProps(
  mode: InvestmentModeId,
): { className: string } & Record<typeof MODE_ATTR, InvestmentModeId> {
  return { className: MODE_PANE_CLASS, [MODE_ATTR]: mode };
}

/** The wrapper props of one of the debt pane's two conditional blocks. */
export function debtBlockProps(role: DebtBlockRole): { className: string } {
  return { className: DEBT_BLOCK_CLASS[role] };
}

/** The placeholder shown until a drawer / an investment group is picked. */
export const DRAWER_EMPTY_PROPS = { className: DRAWER_EMPTY_CLASS } as const;
export const GROUP_EMPTY_PROPS = {
  className: `${GROUP_EMPTY_CLASS} simpleHint`,
} as const;

// ---------------------------------------------------------------------------
// The generated CSS
// ---------------------------------------------------------------------------

/** `input[name="x"]` — with `[value="y"]` when the group has more than one radio. */
function checkedRadio(field: string, value?: string): string {
  const valueFilter = value === undefined ? "" : `[value="${value}"]`;
  return `input[name="${field}"]${valueFilter}:checked`;
}

/**
 * The wizard's whole reveal stylesheet, generated from the tables above.
 *
 * Every rule pairs a checked radio with the pane whose props this same module
 * hands out, so the two halves cannot drift: they are built from the same
 * constants. Order matches what the page emitted before the extraction — hiding
 * the placeholders first, then revealing panes — and the output is deliberately
 * deterministic so a test can assert the pairing.
 */
export function altaRevealCss(): string {
  const form = `.${FORM_CLASS}`;

  return [
    `${form}:has(${checkedRadio(DRAWER_FIELD)}) .${DRAWER_EMPTY_CLASS}{display:none}`,
    ...DRAWERS.map(
      (drawer) =>
        `${form}:has(${checkedRadio(DRAWER_FIELD, drawer.id)}) .${DRAWER_PANE_CLASS}[${DRAWER_ATTR}="${drawer.id}"]{display:grid}`,
    ),
    `${form}:has(${checkedRadio(GROUP_FIELD)}) .${GROUP_EMPTY_CLASS}{display:none}`,
    ...INVESTMENT_GROUPS.flatMap((group) => {
      const groupPane = `.${GROUP_PANE_CLASS}[${GROUP_ATTR}="${group.instrument}"]`;
      return [
        `${form}:has(${checkedRadio(GROUP_FIELD, group.instrument)}) ${groupPane}{display:grid}`,
        ...INVESTMENT_MODES.map(
          (mode) =>
            `${groupPane}:has(${checkedRadio(modeField(group.instrument), mode.id)}) .${MODE_PANE_CLASS}[${MODE_ATTR}="${mode.id}"]{display:${mode.display}}`,
        ),
      ];
    }),
    // Each debt kind hides the block it has no use for (ADR 0056, #677).
    ...DEBT_KINDS.map(
      (kind) =>
        `.${DRAWER_PANE_CLASS}[${DRAWER_ATTR}="deuda"]:has(${checkedRadio(DEBT_KIND_FIELD, kind.id)}) .${DEBT_BLOCK_CLASS[kind.hides]}{display:none}`,
    ),
  ].join("\n");
}
