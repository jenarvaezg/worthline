import {
  type BalanceHistoryProposal,
  parseBalanceHistoryProposalDraft,
} from "./balance-history-proposal-contract";
import type {
  MixedDocumentProposal,
  MixedDocumentSection,
  MixedTrust,
} from "./mixed-document-proposals";
import type { PropertyValuationProposal } from "./property-valuation-proposal-contract";
import { parsePropertyValuationProposalDraft } from "./property-valuation-proposal-contract";
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
  | { kind: "holding"; internalId: string }
  | { kind: "section"; section: ScreenSection }
  | { kind: "figure"; figure: string };

/** Cap the chips so a chatty model can't flood the panel. */
const MAX_ACTIONS = 4;
const MAX_LABEL = 120;
const MAX_PROMPT = 280;

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
 * An internal, same-origin path: rooted at `/`, not protocol-relative (`//`),
 * no backslash tricks, no scheme (`:`). Blocks `javascript:`, `http://…`, and
 * `//evil` while allowing `/patrimonio/x/editar`.
 */
function isInternalHref(href: string): boolean {
  return (
    href.startsWith("/") &&
    !href.startsWith("//") &&
    !href.includes("\\") &&
    !href.includes(":")
  );
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
      const href = boundedString(candidate["href"], MAX_LABEL);
      if (href !== null && isInternalHref(href)) {
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

export function parseBalanceHistoryProposal(raw: unknown): BalanceHistoryProposal | null {
  if (!isRecord(raw) || raw.proposalType !== "balance_history_import") return null;
  const draft = parseBalanceHistoryProposalDraft(raw.draft);
  if (!draft.ok || !isRecord(raw.liability) || typeof raw.liability.id !== "string")
    return null;
  if (
    !Array.isArray(raw.points) ||
    !Array.isArray(raw.curve) ||
    !isRecord(raw.reconciliation)
  )
    return null;
  if (
    typeof raw.reconciliation.expectedMinor !== "number" ||
    typeof raw.reconciliation.resultingMinor !== "number" ||
    typeof raw.reconciliation.matches !== "boolean"
  )
    return null;
  return raw as unknown as BalanceHistoryProposal;
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
      // Internal id lands verbatim in the URL; reject anything with a slash so a
      // resolver miss can never forge a path segment.
      return ref.internalId !== "" && !ref.internalId.includes("/")
        ? `/patrimonio/${ref.internalId}/editar`
        : null;
    case "section":
      return SECTION_ROUTE[ref.section];
    case "figure": {
      const section = FIGURE_SECTION[ref.figure];
      return section ? SECTION_ROUTE[section] : null;
    }
  }
}
