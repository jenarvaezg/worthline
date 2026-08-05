import { isValidIsin } from "./exposure-identity";

/**
 * Instrument identity, filled but never overwritten (#1349).
 *
 * The ISIN and the provider symbol are the most dangerous fields of an
 * investment: the symbol hands the valuation to a quote, and the ISIN is the key
 * every importer claims a row by. A wrong one does not look wrong — it reprices
 * the holding as a different fund, or lets a statement rewrite the operations of
 * the neighbour that shares the key (#1331, #1366).
 *
 * So the chat may fill a HOLE and nothing else: writing into an empty field is
 * the ask that follows a data audit («este fondo no tiene ISIN, póngselo»), while
 * replacing a value that is already there stays on the editing surface, where the
 * user sees the whole holding. This module is the rule, pure and shared: the
 * assistant's proposal builder checks it when the card is drafted and the apply
 * re-checks it against live data, so a second proposal in flight cannot slip a
 * write past the first (a draft carries no lock).
 */

export interface InstrumentIdentityHolding {
  id: string;
  name: string;
  isin?: string;
  providerSymbol?: string;
}

/** What the chat declares. Blank/missing means «not declared». */
export interface InstrumentIdentityDeclaration {
  isin?: string | null | undefined;
  providerSymbol?: string | null | undefined;
}

/** Only the fields being filled travel — never a full metadata replace. */
export interface InstrumentIdentityPatch {
  isin?: string;
  providerSymbol?: string;
}

export type InstrumentIdentityFillResolution =
  | { ok: false; error: string }
  | { ok: true; patch: InstrumentIdentityPatch };

/**
 * Where an overwrite is done instead — named, so the refusal is actionable. The
 * surface, not its route: a URL is app knowledge and the domain has none.
 */
const OVERWRITE_SURFACE = "su ficha del patrimonio (abriendo la posición)";

function normalizeIsin(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toUpperCase();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The symbol's case is NOT normalized: CoinGecko ids are lowercase (`bitcoin`)
 * and Yahoo market suffixes uppercase (`VUSA.L`), so touching it would break one
 * of the two providers.
 */
function normalizeSymbol(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

function occupiedRejection(params: {
  label: string;
  current: string;
  declared: string;
  holdingName: string;
}): string {
  return (
    `«${params.holdingName}» ya tiene ${params.label} ${params.current}, y desde el chat ` +
    `solo puedo rellenar el que está vacío: cambiar uno que ya existe revaloriza la ` +
    `posición como si fuera otro instrumento. Para ponerlo en ${params.declared}, edítalo ` +
    `en ${OVERWRITE_SURFACE}.`
  );
}

function claimedRejection(params: {
  label: string;
  value: string;
  claimantName: string;
}): string {
  return (
    `${params.label} ${params.value} ya lo reclama «${params.claimantName}». El mismo ` +
    `instrumento en dos sitios existe (una posición cerrada y una viva), pero desde el ` +
    `chat no lo doy por hecho: si de verdad son dos, hazlo en ${OVERWRITE_SURFACE}, viendo los dos.`
  );
}

/**
 * Resolve a chat-declared identity fill against the target holding and the rest
 * of the portfolio. Returns the patch to write, or the refusal to say out loud.
 *
 * `portfolio` is every investment holding in the workspace INCLUDING the target
 * (which is skipped by id): re-declaring what the holding already has is a no-op,
 * not a duplicate, and must not be reported as one.
 */
export function resolveInstrumentIdentityFill(input: {
  target: InstrumentIdentityHolding;
  declaration: InstrumentIdentityDeclaration;
  portfolio: readonly InstrumentIdentityHolding[];
}): InstrumentIdentityFillResolution {
  const { target } = input;
  const declaredIsin = normalizeIsin(input.declaration.isin);
  const declaredSymbol = normalizeSymbol(input.declaration.providerSymbol);
  if (declaredIsin === null && declaredSymbol === null) {
    return { ok: false, error: "La corrección de identidad no cambia nada." };
  }

  const currentIsin = normalizeIsin(target.isin);
  const currentSymbol = normalizeSymbol(target.providerSymbol);
  const rivals = input.portfolio.filter((holding) => holding.id !== target.id);
  const patch: InstrumentIdentityPatch = {};

  if (declaredIsin !== null) {
    if (currentIsin === declaredIsin) {
      return {
        ok: false,
        error: `«${target.name}» ya tiene ese ISIN (${declaredIsin}): no hay nada que corregir.`,
      };
    }
    if (currentIsin !== null) {
      return {
        ok: false,
        error: occupiedRejection({
          current: currentIsin,
          declared: declaredIsin,
          holdingName: target.name,
          label: "el ISIN",
        }),
      };
    }
    if (!isValidIsin(declaredIsin)) {
      return {
        ok: false,
        error:
          `${declaredIsin} no es un ISIN válido (son 12 caracteres y el último es un ` +
          "dígito de control). Compruébalo en el documento antes de que lo registre.",
      };
    }
    const claimant = rivals.find(
      (holding) => normalizeIsin(holding.isin) === declaredIsin,
    );
    if (claimant) {
      return {
        ok: false,
        error: claimedRejection({
          claimantName: claimant.name,
          label: "El ISIN",
          value: declaredIsin,
        }),
      };
    }
    patch.isin = declaredIsin;
  }

  if (declaredSymbol !== null) {
    if (currentSymbol === declaredSymbol) {
      return {
        ok: false,
        error: `«${target.name}» ya cotiza por «${declaredSymbol}»: no hay nada que corregir.`,
      };
    }
    if (currentSymbol !== null) {
      return {
        ok: false,
        error: occupiedRejection({
          current: `«${currentSymbol}»`,
          declared: `«${declaredSymbol}»`,
          holdingName: target.name,
          label: "el símbolo de cotización",
        }),
      };
    }
    // A symbol claimed by a neighbour is NOT refused, unlike a duplicated ISIN.
    // The same ETF at two brokers shares its symbol legitimately, both holdings
    // price correctly off the same quote, and the symbol is precisely what an
    // unpriced holding is missing — refusing it would send the most common fill of
    // all to the ficha. What a duplicated ISIN does and this does not is give an
    // importer a second claimant for a row it may overwrite (ADR 0055, #1366).
    patch.providerSymbol = declaredSymbol;
  }

  return { ok: true, patch };
}
