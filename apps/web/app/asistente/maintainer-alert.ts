import type {
  AgentViewCalculationTrace,
  AgentViewHoldingDetail,
} from "@web/agent-view/contract";
import type { MaintainerAlertCategory } from "@worthline/db";

/**
 * The maintainer-alert contract (#1050, decision #1038, ADR 0064). The chat
 * tool `raise_maintainer_alert` is the assistant's ONLY path to a maintainer
 * alert — separate from the proposal path — and it assembles this forensic
 * payload from the read store DETERMINISTICALLY (config snapshot + the S1
 * calculation trace), so the model never re-types the engine's arithmetic into
 * the alert (the lesson of #1034). The payload lives entirely in the control
 * plane; nothing here ever touches the workspace database.
 */

/** The three maintainer-alert categories, re-exported so surfaces share one label map. */
export const MAINTAINER_ALERT_CATEGORIES: readonly MaintainerAlertCategory[] = [
  "infidelity",
  "residual",
  "sync_source",
] as const;

export function isMaintainerAlertCategory(
  value: string,
): value is MaintainerAlertCategory {
  return (MAINTAINER_ALERT_CATEGORIES as readonly string[]).includes(value);
}

/** Human-readable Spanish label for a category (the /admin surface + the tool echo). */
export function maintainerAlertCategoryLabel(category: MaintainerAlertCategory): string {
  switch (category) {
    case "infidelity":
      return "Infidelidad (pintado ≠ recomputado)";
    case "residual":
      return "Residuo inexplicado (> tolerancia)";
    case "sync_source":
      return "Olor a sync/fuente";
  }
}

/** The figure the user declared as correct, with the source and date they gave. */
export interface MaintainerAlertDeclaredFigure {
  balanceMinor: number;
  currency: string;
  date: string;
  source: string;
}

/** A compact config snapshot of the holding at alert time (from the holding detail read). */
export interface MaintainerAlertHoldingSnapshot {
  id: string;
  label: string;
  direction: string;
  instrument: string;
  valuationMethod: string;
}

/**
 * The forensic payload of one maintainer-alert occurrence (#1050). Everything a
 * maintainer needs to diagnose without reconstructing the scenario: the config
 * snapshot, the full calculation trace (or the reason it could not be built),
 * the declared figure, structured data extracted from the user's document
 * (NEVER the binary — process-and-discard, #865 intact), and a conversation
 * reference. Money in the trace stays in raw minor units so declared-vs-computed
 * reconciliation on /admin is exact.
 */
export interface MaintainerAlertPayload {
  category: MaintainerAlertCategory;
  /** The agent's diagnosis — why this smells like a bug (already normalized per the protocol). */
  summary: string;
  holding: MaintainerAlertHoldingSnapshot | null;
  declared?: MaintainerAlertDeclaredFigure;
  /** The full S1 calculation trace, or null when it could not be built. */
  calculationTrace: AgentViewCalculationTrace | null;
  /** Present only when {@link calculationTrace} is null: why (e.g. a 422 reason). */
  calculationTraceUnavailable?: string;
  /** Structured data extracted from the user's document; never the binary. */
  extractedData?: unknown;
  /** A pointer back to the conversation (message id or short excerpt), when supplied. */
  conversationRef?: string;
  /** When the agent raised the alert, as ISO. */
  raisedAt: string;
}

export interface BuildMaintainerAlertPayloadInput {
  category: MaintainerAlertCategory;
  summary: string;
  raisedAt: string;
  detail: AgentViewHoldingDetail | null;
  calculationTrace: AgentViewCalculationTrace | null;
  calculationTraceUnavailable?: string;
  declared?: MaintainerAlertDeclaredFigure;
  extractedData?: unknown;
  conversationRef?: string;
}

/**
 * Assemble the forensic payload from already-read facts (pure). The tool does
 * the reads; this only shapes them, so it is unit-testable without a store.
 */
export function buildMaintainerAlertPayload(
  input: BuildMaintainerAlertPayloadInput,
): MaintainerAlertPayload {
  return {
    category: input.category,
    summary: input.summary,
    holding: input.detail
      ? {
          id: input.detail.id,
          label: input.detail.label,
          direction: input.detail.direction,
          instrument: input.detail.instrument,
          valuationMethod: input.detail.valuationMethod,
        }
      : null,
    calculationTrace: input.calculationTrace,
    raisedAt: input.raisedAt,
    ...(input.calculationTraceUnavailable === undefined
      ? {}
      : { calculationTraceUnavailable: input.calculationTraceUnavailable }),
    ...(input.declared === undefined ? {} : { declared: input.declared }),
    ...(input.extractedData === undefined ? {} : { extractedData: input.extractedData }),
    ...(input.conversationRef === undefined
      ? {}
      : { conversationRef: input.conversationRef }),
  };
}
