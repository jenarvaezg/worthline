/**
 * Bounding the ONE part of a maintainer-alert payload a model fills in freely
 * (#1180): `extractedData`, shaped from a document the user supplied.
 *
 * Everything else in the payload is assembled deterministically from the read
 * store (see `maintainer-alert.ts`), so this is the only unbounded surface. Its
 * own module rather than living inside the alert contract: the walk is generic
 * JSON hygiene, and the contract file should change when the ALERT changes.
 */
/**
 * The caps. `extractedData` is persisted in the control plane and rendered on
 * `/admin`, so an unbounded blob is a storage-and-render amplification vector: a pathological spreadsheet
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
