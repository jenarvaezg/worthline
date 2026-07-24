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

/**
 * Bounds on `extractedData` (#1180) — the ONE part of the payload a model fills
 * in freely, from a document the user supplied. Everything else here is assembled
 * deterministically from the read store, so this is the only unbounded surface.
 *
 * It is persisted in the control plane and rendered on `/admin`, so an unbounded
 * blob is a storage-and-render amplification vector: a pathological spreadsheet
 * could push megabytes per alert into a row that a maintainer then has to open.
 * The caps are deliberately generous — a real extraction is a handful of rows —
 * so bounding costs nothing a maintainer would miss.
 *
 * `maxSerializedChars` is the backstop: many individually-legal nodes can still
 * add up, so the bounded value is measured once more and replaced wholesale if it
 * is still over budget.
 */
export const EXTRACTED_DATA_LIMITS = {
  maxDepth: 6,
  maxStringChars: 2_000,
  maxArrayItems: 200,
  maxObjectKeys: 100,
  maxSerializedChars: 16_384,
  /** Key (and array sentinel prefix) that reports what the caps removed. */
  omittedKey: "__omitido",
} as const;

/** Marker left where the depth cap stopped the walk. */
const DEPTH_MARKER = "…[profundidad máxima superada]";

/**
 * Bound one node of the extraction: truncate long strings, cap array length and
 * key count, and stop at {@link EXTRACTED_DATA_LIMITS.maxDepth}. The depth cap is
 * also what makes a self-referencing object safe — the walk terminates instead of
 * recursing until the stack dies.
 *
 * Values JSON cannot carry are normalized rather than emitted as `undefined`
 * holes: functions/symbols/undefined are dropped, `bigint` becomes its decimal
 * string, non-finite numbers become `null` (what `JSON.stringify` would do).
 */
function boundNode(value: unknown, depth: number): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return value.length > EXTRACTED_DATA_LIMITS.maxStringChars
        ? `${value.slice(0, EXTRACTED_DATA_LIMITS.maxStringChars)}…[+${
            value.length - EXTRACTED_DATA_LIMITS.maxStringChars
          } car.]`
        : value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "object":
      break;
    default:
      // function / symbol / undefined — not representable, drop the entry.
      return undefined;
  }

  if (depth >= EXTRACTED_DATA_LIMITS.maxDepth) return DEPTH_MARKER;

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, EXTRACTED_DATA_LIMITS.maxArrayItems)
      .map((item) => boundNode(item, depth + 1) ?? null);
    const dropped = value.length - kept.length;
    return dropped > 0 ? [...kept, `…[${dropped} elementos omitidos]`] : kept;
  }

  // A Date (or anything else with a toJSON) keeps its own serialization; that is
  // what the control-plane row would have stored anyway.
  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === "function") {
    return boundNode((withToJson.toJSON as () => unknown)(), depth);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const bounded: Record<string, unknown> = {};
  for (const [key, nested] of entries.slice(0, EXTRACTED_DATA_LIMITS.maxObjectKeys)) {
    const boundedNested = boundNode(nested, depth + 1);
    if (boundedNested !== undefined) bounded[key] = boundedNested;
  }
  const droppedKeys = entries.length - EXTRACTED_DATA_LIMITS.maxObjectKeys;
  if (droppedKeys > 0) {
    bounded[EXTRACTED_DATA_LIMITS.omittedKey] = `${droppedKeys} claves omitidas`;
  }
  return bounded;
}

/**
 * Bound the model-supplied extraction before it is persisted (#1180). Pure, so
 * the hostile shapes are unit-testable: deep nesting, cycles, huge strings, wide
 * objects, long arrays, and a blob that only busts the budget in aggregate.
 *
 * `undefined` stays `undefined` so the payload key remains genuinely optional.
 */
export function boundExtractedData(value: unknown): unknown {
  if (value === undefined) return undefined;

  const bounded = boundNode(value, 0) ?? null;
  const serialized = JSON.stringify(bounded) ?? "null";
  if (serialized.length <= EXTRACTED_DATA_LIMITS.maxSerializedChars) return bounded;

  return {
    [EXTRACTED_DATA_LIMITS.omittedKey]:
      `datos extraídos omitidos: ${serialized.length} caracteres superan el límite ` +
      `de ${EXTRACTED_DATA_LIMITS.maxSerializedChars}`,
  };
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
    // Bounded HERE, in the one shaping seam every caller goes through (#1180), so
    // the control-plane row is what stays small — not just the /admin render.
    ...(input.extractedData === undefined
      ? {}
      : { extractedData: boundExtractedData(input.extractedData) }),
    ...(input.conversationRef === undefined
      ? {}
      : { conversationRef: input.conversationRef }),
  };
}
