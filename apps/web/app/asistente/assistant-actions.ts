import type {
  ExposureProfileProposal,
  ExposureProfileProposalPreview,
  ExposureProfileProposalPreviewProfile,
} from "./exposure-profile-proposals";
import type { ScreenSection } from "./screen-context";

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
  resumen: "/",
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

function isPreviewProfile(
  value: unknown,
): value is ExposureProfileProposalPreviewProfile {
  return (
    isRecord(value) &&
    isRecord(value["breakdowns"]) &&
    typeof value["hedged"] === "boolean" &&
    (typeof value["ter"] === "string" || value["ter"] === null) &&
    (typeof value["trackedIndex"] === "string" || value["trackedIndex"] === null)
  );
}

function isProposalPreview(value: unknown): value is ExposureProfileProposalPreview {
  return (
    isRecord(value) &&
    typeof value["key"] === "string" &&
    Array.isArray(value["labels"]) &&
    value["labels"].every((label) => typeof label === "string") &&
    isPreviewProfile(value["before"]) &&
    isPreviewProfile(value["after"])
  );
}

export function parseExposureProfileProposal(
  raw: unknown,
): ExposureProfileProposal | null {
  if (!isRecord(raw) || raw["proposalType"] !== "exposure_profiles") return null;
  if (!Array.isArray(raw["drafts"]) || !Array.isArray(raw["previews"])) return null;
  if (!raw["previews"].every(isProposalPreview)) return null;

  return {
    proposalType: "exposure_profiles",
    drafts: raw["drafts"] as ExposureProfileProposal["drafts"],
    previews: raw["previews"],
  };
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
