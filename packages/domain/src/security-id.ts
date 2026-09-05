import type { Instrument } from "./instrument-catalog";

/** Canonical security identifiers. A provider symbol is a price lookup, not one of these. */
export type SecurityIdKind = "isin" | "dgs";

export interface SecurityId {
  kind: SecurityIdKind;
  value: string;
}

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const DGS_PATTERN = /^N\d{4}$/;

/** A plan's DGS code, normalized for storage, or null when it is not a plan code. */
export function normalizeDgsCode(value: string): string | null {
  const normalized = value.trim().toUpperCase().replace(/[-\s]/g, "");
  return DGS_PATTERN.test(normalized) ? normalized : null;
}

/** Total classifier for imported data: invalid or non-string input has no identity. */
export function classifySecurityId(value: unknown): SecurityId | null {
  if (typeof value !== "string") return null;
  const isin = validIsinOrNull(value);
  if (isin) return { kind: "isin", value: isin };
  const dgs = normalizeDgsCode(value);
  return dgs ? { kind: "dgs", value: dgs } : null;
}

/**
 * Write boundary for a declared identifier kind. Blank remains null, as in the
 * legacy ISIN column validator; whether a form requires a value is a separate
 * concern. A nonblank value must match its declared kind, never another kind.
 */
export function normalizedSecurityIdColumnValue(
  kind: SecurityIdKind,
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const classified = classifySecurityId(trimmed);
  if (classified?.kind === kind) return classified.value;
  const compact = trimmed.toUpperCase().replace(/[-\s]/g, "");
  if (/^F\d{4}$/.test(compact)) {
    throw new Error(
      `${compact} es el código del fondo de pensiones, no del plan; el del plan empieza por N y también está impreso en tu papel.`,
    );
  }
  throw new Error(
    kind === "isin"
      ? "Introduce un ISIN válido: 12 caracteres con su dígito de control."
      : "Introduce un código DGS de plan válido: N seguida de cuatro cifras (por ejemplo, N5394).",
  );
}

/** The instrument selects both the input label and its write-validation kind. */
export function securityIdFieldForInstrument(
  instrument: Instrument,
): { kind: SecurityIdKind; label: string } | null {
  switch (instrument) {
    case "pension_plan":
      return { kind: "dgs", label: "Código DGS" };
    case "fund":
    case "etf":
    case "stock":
    case "index":
      return { kind: "isin", label: "ISIN" };
    default:
      return null;
  }
}

/** The canonical ISIN used by classification, catalog registration and lookup. */
export function validIsinOrNull(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized && isValidIsin(normalized) ? normalized : null;
}

/** ISO 6166 shape and check digit. Callers normalize case/outer whitespace first. */
export function isValidIsin(value: string): boolean {
  if (!ISIN_PATTERN.test(value)) return false;
  const expanded = [...value]
    .map((character) => {
      if (character >= "0" && character <= "9") return character;
      return String(character.charCodeAt(0) - 55);
    })
    .join("");
  let sum = 0;
  let alternate = false;
  for (let index = expanded.length - 1; index >= 0; index -= 1) {
    let digit = Number(expanded[index]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}
