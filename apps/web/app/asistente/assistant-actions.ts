import { holdingDetailHref, isPublicHoldingId } from "@web/holding-route";
import {
  type BalanceHistoryProposal,
  parseBalanceHistoryProposalDraft,
} from "./balance-history-proposal-contract";
import {
  type CorrectionProposal,
  parseCorrectionProposalDraft,
} from "./correction-proposal-contract";
import type { EarlyRepaymentProposal } from "./early-repayment-proposal-contract";
import { parseEarlyRepaymentProposalDraft } from "./early-repayment-proposal-contract";
import {
  type HoldingCreationProposal,
  parseHoldingCreationProposalDraft,
} from "./holding-creation-proposal-contract";
import {
  type HoldingTrashProposal,
  parseHoldingTrashProposalDraft,
} from "./holding-trash-proposal-contract";
import type {
  MixedDocumentProposal,
  MixedDocumentSection,
  MixedTrust,
} from "./mixed-document-proposals";
import {
  type OperationProposal,
  parseOperationProposalDraft,
} from "./operation-proposal-contract";
import type { PropertyValuationProposal } from "./property-valuation-proposal-contract";
import { parsePropertyValuationProposalDraft } from "./property-valuation-proposal-contract";
import { internalProseLinkHref } from "./prose-link";
import type { ReconcileRow } from "./reconcile-plan";
import {
  parseReconcileProposalDraft,
  type ReconcileProposal,
} from "./reconcile-proposal-contract";
import type { ScreenSection } from "./screen-context";
import type { StatementImportProposal } from "./statement-import-proposals";
import { parseStatementImportProposalDraft } from "./statement-import-proposals";

/**
 * Typed read-only quick actions and internal-source destinations (#631, ADR
 * 0053/0052). The model may PROPOSE actions, but the app renders only what
 * validates against this small typed set, and navigates only to internal
 * worthline surfaces — the model never hands over a raw URL, so there is no
 * open-redirect or scheme-injection surface. Nothing here mutates data.
 *
 * Pure by design: the chat tool resolves a model's public-id reference to an
 * internal id (needs the store), then these functions decide the destination
 * and the final typed shape — both unit-testable in the node env.
 */

export interface OpenInternalSourceAction {
  type: "openInternalSource";
  label: string;
  /** A resolved INTERNAL path (`/…`). Never a model-supplied URL. */
  href: string;
}

export interface RunSuggestedAnalysisAction {
  type: "runSuggestedAnalysis";
  label: string;
  /** The follow-up prompt to seed into the same open conversation. */
  prompt: string;
}

export type QuickAction = OpenInternalSourceAction | RunSuggestedAnalysisAction;

/** A cited source the tool resolved, before we know if it maps to a surface. */
export type SourceRef =
  | { kind: "holding"; publicId: string }
  | { kind: "section"; section: ScreenSection }
  | { kind: "figure"; figure: string };

/** Cap the chips so a chatty model can't flood the panel. */
export const MAX_ACTIONS = 4;
export const MAX_LABEL = 120;
export const MAX_PROMPT = 280;

/** Product routes per section; `otra` has no single destination. */
const SECTION_ROUTE: Record<ScreenSection, string | null> = {
  resumen: "/app",
  patrimonio: "/patrimonio",
  historico: "/historico",
  objetivos: "/objetivos",
  ajustes: "/ajustes",
  otra: null,
};

/** Which surface owns each explainable figure. */
const FIGURE_SECTION: Record<string, ScreenSection> = {
  net_worth: "patrimonio",
  liquid_net_worth: "patrimonio",
  gross_assets: "patrimonio",
  debts: "patrimonio",
  housing_equity: "patrimonio",
  liquidity_breakdown: "patrimonio",
  holding_value: "patrimonio",
  fire_eligible_assets: "objetivos",
  fire_progress: "objetivos",
};

/**
 * The path a chip may navigate to, or null: rooted at `/`, not protocol-relative
 * (`//`), no backslash tricks, no scheme (`:`). Blocks `javascript:`, `http://…` and
 * `//evil` while allowing `/patrimonio/x/editar`.
 *
 * Returns the CLEANED path and decides on it, never on the raw string (#1407): the
 * URL parser DELETES tabs, LF and CR before resolving, so `/<tab>/evil.test/x` reads
 * as a single-slash path — no backslash, no colon — and then navigates to
 * `https://evil.test/x`. `internalProseLinkHref` strips exactly those characters,
 * which is the same gate a link written in the prose goes through (#1289); the two
 * extra checks here are what the chip channel adds on top of it.
 */
function internalActionHref(href: string): string | null {
  const cleaned = internalProseLinkHref(href);
  return cleaned !== null && !cleaned.includes("\\") && !cleaned.includes(":")
    ? cleaned
    : null;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/**
 * Validate model-proposed actions into the typed set, dropping anything outside
 * it or malformed (ADR 0053). Runs on already-server-resolved actions as a
 * final trust boundary before render, and capped.
 */
export function parseQuickActions(raw: unknown): QuickAction[] {
  if (!Array.isArray(raw)) return [];

  const actions: QuickAction[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const label = boundedString(candidate["label"], MAX_LABEL);
    if (label === null) continue;

    if (candidate["type"] === "openInternalSource") {
      const written = boundedString(candidate["href"], MAX_LABEL);
      const href = written === null ? null : internalActionHref(written);
      if (href !== null) {
        actions.push({ type: "openInternalSource", label, href });
      }
    } else if (candidate["type"] === "runSuggestedAnalysis") {
      const prompt = boundedString(candidate["prompt"], MAX_PROMPT);
      if (prompt !== null) {
        actions.push({ type: "runSuggestedAnalysis", label, prompt });
      }
    }

    if (actions.length === MAX_ACTIONS) break;
  }

  return actions;
}

const SCREEN_SECTIONS = new Set<ScreenSection>([
  "resumen",
  "patrimonio",
  "historico",
  "objetivos",
  "ajustes",
  "otra",
]);

function parseScreenSection(value: unknown): ScreenSection | null {
  return typeof value === "string" && SCREEN_SECTIONS.has(value as ScreenSection)
    ? (value as ScreenSection)
    : null;
}

/**
 * Resolve model-proposed quick actions before the server has turned refs into
 * hrefs — covers the failure mode where the model prints `{"actions":[…]}`
 * in text instead of calling `suggest_actions`.
 */
export function resolveModelQuickActions(raw: unknown): QuickAction[] {
  if (!Array.isArray(raw)) return [];

  const actions: QuickAction[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const label = boundedString(item["label"], MAX_LABEL);
    if (label === null) continue;

    if (item["type"] === "openInternalSource") {
      const rawHref = boundedString(item["href"], MAX_LABEL);
      const hrefDirect = rawHref === null ? null : internalActionHref(rawHref);
      if (hrefDirect !== null) {
        actions.push({ type: "openInternalSource", label, href: hrefDirect });
      } else {
        const holding = boundedString(item["holding"], MAX_LABEL);
        const section = parseScreenSection(item["section"]);
        const figure = boundedString(item["figure"], MAX_LABEL);
        let resolved: string | null = null;
        if (holding !== null) {
          resolved = sourceHref({ kind: "holding", publicId: holding });
        } else if (section !== null) {
          resolved = sourceHref({ kind: "section", section });
        } else if (figure !== null) {
          resolved = sourceHref({ kind: "figure", figure });
        }
        // Through the same gate as a href written in the text, resolved or not: one
        // place decides what a chip may point at, and `OpenInternalSourceAction.href`
        // being a string is then true by construction rather than by inspection.
        const href = resolved === null ? null : internalActionHref(resolved);
        if (href !== null) {
          actions.push({ type: "openInternalSource", label, href });
        }
      }
    } else if (item["type"] === "runSuggestedAnalysis") {
      const prompt = boundedString(item["prompt"], MAX_PROMPT);
      if (prompt !== null) {
        actions.push({ type: "runSuggestedAnalysis", label, prompt });
      }
    }

    if (actions.length === MAX_ACTIONS) break;
  }

  return actions;
}

/**
 * Strip a trailing `{"actions":[…]}` block from assistant text and recover any
 * typed quick actions the model printed instead of calling `suggest_actions`.
 */
export function extractEmbeddedQuickActions(text: string): {
  cleaned: string;
  actions: QuickAction[];
} {
  const trimmedEnd = text.trimEnd();
  let depth = 0;
  for (let i = trimmedEnd.length - 1; i >= 0; i--) {
    const ch = trimmedEnd[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      depth -= 1;
      if (depth !== 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedEnd.slice(i));
      } catch {
        return { cleaned: text, actions: [] };
      }

      if (!isRecord(parsed) || !Array.isArray(parsed["actions"])) {
        return { cleaned: text, actions: [] };
      }

      const actions = resolveModelQuickActions(parsed["actions"]);
      if (actions.length === 0) return { cleaned: text, actions: [] };

      return { cleaned: trimmedEnd.slice(0, i).trimEnd(), actions };
    }
  }

  return { cleaned: text, actions: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositionImpact(impact: unknown): boolean {
  if (
    !isRecord(impact) ||
    typeof impact.beforeUnits !== "string" ||
    typeof impact.afterUnits !== "string" ||
    typeof impact.beforeValueMinor !== "number" ||
    typeof impact.afterValueMinor !== "number" ||
    !Array.isArray(impact.flags) ||
    !impact.flags.every((flag) => typeof flag === "string")
  )
    return false;
  return true;
}

function isFundPreviewRow(value: unknown): boolean {
  if (!isRecord(value) || typeof value["isin"] !== "string") return false;
  if (typeof value["executedCount"] !== "number") return false;
  if (!isPositionImpact(value["positionImpact"])) return false;
  if (value["bucket"] === "matched")
    return value.existingName === undefined || typeof value.existingName === "string";
  return (
    value["bucket"] === "new" &&
    (value.suggestedName === undefined || typeof value.suggestedName === "string") &&
    (value.suggestedSymbol === undefined || typeof value.suggestedSymbol === "string")
  );
}

export function parseStatementImportProposal(
  raw: unknown,
): StatementImportProposal | null {
  if (!isRecord(raw) || raw["proposalType"] !== "statement_import") return null;
  if (!Array.isArray(raw["funds"]) || !raw["funds"].every(isFundPreviewRow)) return null;

  const parsed = parseStatementImportProposalDraft(raw["draft"]);
  if (!parsed.ok) return null;

  return {
    proposalType: "statement_import",
    draft: parsed.draft,
    funds: raw["funds"] as StatementImportProposal["funds"],
  };
}

export function parseCorrectionProposal(raw: unknown): CorrectionProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "correction") return null;
  const draft = parseCorrectionProposalDraft(raw.draft);
  if (
    draft === null ||
    !isRecord(raw.holding) ||
    typeof raw.holding.id !== "string" ||
    typeof raw.holding.name !== "string" ||
    typeof raw.summary !== "string" ||
    typeof raw.folio !== "string" ||
    !isRecord(raw.guarantee) ||
    typeof raw.guarantee.state !== "string"
  ) {
    return null;
  }
  if (raw.mode === "solo-desde-hoy" && Array.isArray(raw.edits)) {
    return raw as unknown as CorrectionProposal;
  }
  if (
    raw.mode === "reconstruir" &&
    Array.isArray(raw.series) &&
    Array.isArray(raw.curve) &&
    typeof raw.anchorMinor === "number" &&
    // El veredicto de reconciliación (#1422) es parte del contrato: la tarjeta
    // PINTA sus cifras y anuncia con ellas lo que hará el confirmar. Una pestaña
    // vieja de antes del deploy pierde la tarjeta —el borrador sigue ahí y el
    // turno siguiente la reconstruye— en vez de reventar al desreferenciar un
    // campo que ese payload no trae.
    isBalanceReconciliation(raw.reconciliation)
  ) {
    return raw as unknown as CorrectionProposal;
  }
  return null;
}

export function parseHoldingCreationProposal(
  raw: unknown,
): HoldingCreationProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "holding_creation") return null;
  const draft = parseHoldingCreationProposalDraft(raw.draft);
  if (
    draft === null ||
    typeof raw.folio !== "string" ||
    typeof raw.family !== "string" ||
    !isRecord(raw.holding) ||
    typeof raw.holding.name !== "string" ||
    typeof raw.holding.instrumentLabel !== "string" ||
    typeof raw.holding.detail !== "string" ||
    !isRecord(raw.impact) ||
    // beforeMinor/afterMinor are null when the net-worth read degraded (ADR 0048):
    // accept number-or-null; only the delta is always a number.
    !(raw.impact.beforeMinor === null || typeof raw.impact.beforeMinor === "number") ||
    !(raw.impact.afterMinor === null || typeof raw.impact.afterMinor === "number") ||
    typeof raw.impact.deltaMinor !== "number"
  ) {
    return null;
  }
  return raw as unknown as HoldingCreationProposal;
}

/**
 * Shallow shape check for a reconcile row off the tool stream (own JSON). The
 * movement evidence (#1373) is part of the check on purpose: the card PRINTS those
 * lines and sums them into the impact header, so a row shape this version does not
 * carry is not something to render half of — a stale tab across a deploy loses the
 * card (the draft is still there, and the next turn rebuilds it) rather than showing
 * a `+0 €` header with no evidence under it, which is the very bug being fixed.
 */
function isReconcileRow(value: unknown): value is ReconcileRow {
  return (
    isRecord(value) &&
    typeof value.rowId === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.movements) &&
    typeof value.movementsDeltaMinor === "number" &&
    isRecord(value.match) &&
    typeof value.match.decision === "string"
  );
}

/**
 * Trust-boundary parser for a reconcile proposal (#1108) coming back off the tool
 * stream: validates the discriminant, the draft handle, the nullable net-worth
 * header (ADR 0048) and the editable rows the card renders.
 */
export function parseReconcileProposal(raw: unknown): ReconcileProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "reconcile") return null;
  const draft = parseReconcileProposalDraft(raw.draft);
  if (
    draft === null ||
    !(raw.netWorthBeforeMinor === null || typeof raw.netWorthBeforeMinor === "number") ||
    !Array.isArray(raw.rows) ||
    !raw.rows.every(isReconcileRow)
  ) {
    return null;
  }
  return raw as unknown as ReconcileProposal;
}

/**
 * Trust-boundary parser for a baja/restauración proposal (#1106) coming back off
 * the tool stream. Validates the discriminant, the draft handle, the impact
 * triple (before/after nullable when the read degraded, ADR 0048) and the three
 * arrays the card renders. `proposalType` pins which mirror kind is expected.
 */
export function parseHoldingTrashProposal(
  raw: unknown,
  proposalType: "holding_removal" | "holding_restoration",
): HoldingTrashProposal | null {
  if (!isRecord(raw) || raw.proposalType !== proposalType) return null;
  const draft = parseHoldingTrashProposalDraft(raw.draft);
  if (
    draft === null ||
    typeof raw.folio !== "string" ||
    (raw.operation !== "remove" && raw.operation !== "restore") ||
    !Array.isArray(raw.lines) ||
    !Array.isArray(raw.orphanPairs) ||
    !Array.isArray(raw.duplicates) ||
    !isRecord(raw.impact) ||
    !(raw.impact.beforeMinor === null || typeof raw.impact.beforeMinor === "number") ||
    !(raw.impact.afterMinor === null || typeof raw.impact.afterMinor === "number") ||
    typeof raw.impact.deltaMinor !== "number"
  ) {
    return null;
  }
  return raw as unknown as HoldingTrashProposal;
}

/**
 * Shape check for the reconciliation verdict (#1422). Every field the cards read
 * is checked, including `anchor`, because they are DESREFERENCED at render: a
 * half-verdict off a stale tab would throw inside the assistant layer, which is
 * the failure this boundary exists to prevent.
 */
function isBalanceReconciliation(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    typeof raw.status === "string" &&
    typeof raw.against === "string" &&
    typeof raw.matches === "boolean" &&
    typeof raw.expectedMinor === "number" &&
    typeof raw.resultingMinor === "number" &&
    typeof raw.deltaMinor === "number" &&
    typeof raw.toleranceMinor === "number" &&
    isRecord(raw.anchor) &&
    typeof raw.anchor.declaredMinor === "number" &&
    typeof raw.anchor.modelMinor === "number" &&
    typeof raw.anchor.driftMinor === "number" &&
    typeof raw.anchor.stale === "boolean"
  );
}

export function parseBalanceHistoryProposal(raw: unknown): BalanceHistoryProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "balance_history_import") return null;
  const draft = parseBalanceHistoryProposalDraft(raw.draft);
  if (!draft.ok || !isRecord(raw.liability) || typeof raw.liability.id !== "string")
    return null;
  if (!Array.isArray(raw.points) || !Array.isArray(raw.curve)) return null;
  if (!isBalanceReconciliation(raw.reconciliation)) return null;
  return raw as unknown as BalanceHistoryProposal;
}

/**
 * Trust boundary for an early-repayment proposal (#1245). Every rendered figure
 * is a STRING the server already formatted, so the card cannot re-derive money or
 * dates client-side; only the shape is checked here.
 */
export function parseEarlyRepaymentProposal(raw: unknown): EarlyRepaymentProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "early_repayment") return null;
  const draft = parseEarlyRepaymentProposalDraft(raw.draft);
  if (!draft.ok || !isRecord(raw.holding) || typeof raw.holding.name !== "string") {
    return null;
  }
  if (!isRecord(raw.repayment) || typeof raw.summary !== "string") return null;
  const { repayment } = raw;
  if (
    typeof repayment.date !== "string" ||
    typeof repayment.dateLabel !== "string" ||
    typeof repayment.boundaryDate !== "string" ||
    typeof repayment.amount !== "string" ||
    typeof repayment.modeLabel !== "string" ||
    (repayment.mode !== "reduce-term" && repayment.mode !== "reduce-payment")
  ) {
    return null;
  }
  if (!Array.isArray(raw.rows) || !Array.isArray(raw.notes)) return null;
  if (
    !raw.rows.every(
      (row) =>
        isRecord(row) &&
        typeof row.label === "string" &&
        typeof row.before === "string" &&
        typeof row.after === "string",
    ) ||
    !raw.notes.every((note) => typeof note === "string")
  ) {
    return null;
  }
  if (raw.reconciliation !== null) {
    if (
      !isRecord(raw.reconciliation) ||
      typeof raw.reconciliation.observed !== "string" ||
      typeof raw.reconciliation.plan !== "string" ||
      typeof raw.reconciliation.matches !== "boolean"
    ) {
      return null;
    }
  }
  return raw as unknown as EarlyRepaymentProposal;
}

/**
 * Trust boundary for an operation proposal (#1374). Every rendered figure is a STRING
 * the server already formatted — the fact line, the participaciones, the destination —
 * so the card cannot re-derive money, a quantity or a date; only the shape is checked.
 * The impact triple is nullable on both ends when the net-worth read degraded (ADR
 * 0048), and the delta never is.
 */
export function parseOperationProposal(raw: unknown): OperationProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "investment_operation") return null;
  const draft = parseOperationProposalDraft(raw.draft);
  if (!draft.ok || typeof raw.summary !== "string" || typeof raw.folio !== "string") {
    return null;
  }
  if (
    !isRecord(raw.document) ||
    typeof raw.document.line !== "string" ||
    typeof raw.document.fact !== "string" ||
    !isRecord(raw.holding) ||
    typeof raw.holding.name !== "string" ||
    typeof raw.holding.destination !== "string" ||
    !isRecord(raw.position) ||
    typeof raw.position.unitsBefore !== "string" ||
    typeof raw.position.unitsAfter !== "string" ||
    typeof raw.impactCaption !== "string"
  ) {
    return null;
  }
  if (
    !isRecord(raw.impact) ||
    !(raw.impact.beforeMinor === null || typeof raw.impact.beforeMinor === "number") ||
    !(raw.impact.afterMinor === null || typeof raw.impact.afterMinor === "number") ||
    typeof raw.impact.deltaMinor !== "number"
  ) {
    return null;
  }
  if (!Array.isArray(raw.notes) || !raw.notes.every((note) => typeof note === "string")) {
    return null;
  }
  return raw as unknown as OperationProposal;
}

export function parsePropertyValuationProposal(
  raw: unknown,
): PropertyValuationProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "property_valuation_anchor") return null;
  const draft = parsePropertyValuationProposalDraft(raw.draft);
  if (
    !draft.ok ||
    !isRecord(raw.property) ||
    !isRecord(raw.anchor) ||
    !isRecord(raw.trust)
  )
    return null;
  if (
    typeof raw.property.id !== "string" ||
    typeof raw.property.name !== "string" ||
    typeof raw.anchor.valuationDate !== "string" ||
    typeof raw.anchor.valueMinor !== "number" ||
    raw.trust.tier !== "unverified" ||
    raw.trust.requiresReview !== true ||
    !Array.isArray(raw.curve)
  )
    return null;
  return raw as unknown as PropertyValuationProposal;
}

export function parseMixedDocumentProposal(raw: unknown): MixedDocumentProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "mixed_document_import") return null;
  if (
    !isRecord(raw.draft) ||
    typeof raw.draft.proposalId !== "string" ||
    !Array.isArray(raw.sections) ||
    !raw.sections.every(isMixedDocumentSection)
  )
    return null;
  return {
    draft: { proposalId: raw.draft.proposalId },
    proposalType: "mixed_document_import",
    sections: raw.sections,
  };
}

function isMixedTrust(value: unknown): value is MixedTrust {
  return (
    isRecord(value) &&
    typeof value.requiresReview === "boolean" &&
    (value.tier === "reconciled" ||
      value.tier === "unverified" ||
      value.tier === "mismatch")
  );
}

function isMoneyPoint(value: unknown, moneyKey: string): boolean {
  return (
    isRecord(value) &&
    typeof value.date === "string" &&
    typeof value[moneyKey] === "number"
  );
}

function isDebtPreviewPoint(value: unknown): boolean {
  return (
    isMoneyPoint(value, "balanceMinor") &&
    isRecord(value) &&
    (value.driftMinor === null || typeof value.driftMinor === "number") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.status === "accepted" ||
      value.status === "skipped" ||
      value.status === "excluded")
  );
}

function isMixedDocumentSection(value: unknown): value is MixedDocumentSection {
  if (!isRecord(value) || typeof value.assetKey !== "string" || !isRecord(value.preview))
    return false;
  const preview = value.preview;
  if (!isMixedTrust(preview.trust)) return false;
  if (value.kind === "investment_statement") {
    return (
      Array.isArray(preview.funds) &&
      preview.funds.length > 0 &&
      preview.funds.every(isFundPreviewRow) &&
      isRecord(preview.reconciliation) &&
      typeof preview.reconciliation.matches === "boolean" &&
      isPositionImpact(preview.reconciliation.positionImpact)
    );
  }
  if (value.kind === "debt_balance_history") {
    return (
      isRecord(preview.liability) &&
      typeof preview.liability.id === "string" &&
      typeof preview.liability.name === "string" &&
      Array.isArray(preview.points) &&
      preview.points.every(isDebtPreviewPoint) &&
      Array.isArray(preview.curve) &&
      preview.curve.every((point) => isMoneyPoint(point, "balanceMinor")) &&
      isRecord(preview.reconciliation) &&
      typeof preview.reconciliation.matches === "boolean" &&
      typeof preview.reconciliation.expectedMinor === "number" &&
      typeof preview.reconciliation.resultingMinor === "number"
    );
  }
  if (value.kind === "property_valuation") {
    return (
      isRecord(preview.property) &&
      typeof preview.property.id === "string" &&
      typeof preview.property.name === "string" &&
      Array.isArray(preview.anchors) &&
      preview.anchors.length > 0 &&
      preview.anchors.every(
        (anchor) =>
          isRecord(anchor) &&
          typeof anchor.assetId === "string" &&
          typeof anchor.valuationDate === "string" &&
          typeof anchor.valueMinor === "number",
      ) &&
      Array.isArray(preview.curve) &&
      preview.curve.every((point) => isMoneyPoint(point, "valueMinor"))
    );
  }
  return false;
}

/** Resolve a cited internal source to its product route, or null if it has none. */
export function sourceHref(ref: SourceRef): string | null {
  switch (ref.kind) {
    case "holding":
      // The public `wl_hld_…` id lands verbatim in the URL — the same id the
      // model reads from every tool, and since #1318 the same one the route
      // takes. (It used to be spliced in as an INTERNAL id, so a chip pointing
      // at a holding built a URL the router never accepted.)
      //
      // The shape check is the cheap half of the guard, and it earns its keep:
      // #1318 records the model INVENTING `asset_fidelity_s_p_500_index_fund_…`
      // after watching the URL bar. A chip is a link the user will click, so an
      // id in the retired vocabulary is dropped here rather than rendered as a
      // guaranteed 404. Slashes are rejected with it, so a miss upstream can
      // never forge extra path segments.
      return isPublicHoldingId(ref.publicId) && !ref.publicId.includes("/")
        ? holdingDetailHref(ref.publicId)
        : null;
    case "section":
      return SECTION_ROUTE[ref.section] ?? null;
    case "figure": {
      // Own properties only, and `?? null` on both lookups (#1407). The figure name
      // comes from the model, and every object inherits `constructor`, `toString` and
      // `hasOwnProperty` from its prototype: a plain `FIGURE_SECTION[ref.figure]`
      // returned the truthy `Object` constructor for «constructor», which then indexed
      // `SECTION_ROUTE` to `undefined` — and `undefined` is not `null`, so it slipped
      // through every `!== null` guard downstream and became a chip with NO href, a
      // `<Link href={undefined}>` that throws while rendering the assistant panel.
      const section = Object.hasOwn(FIGURE_SECTION, ref.figure)
        ? FIGURE_SECTION[ref.figure]
        : undefined;
      return section === undefined ? null : (SECTION_ROUTE[section] ?? null);
    }
  }
}
