import {
  classifySecurityId,
  declaredSecurityId,
  normalizedSecurityIdColumnValue,
  SECURITY_ID_KIND_LABEL_INLINE,
  type SecurityId,
  type StoredSecurityId,
} from "./security-id";

/**
 * Instrument identity, filled but never overwritten (#1349).
 *
 * The security id and the provider symbol are the most dangerous fields of an
 * investment: the symbol hands the valuation to a quote, and the identifier is the
 * key every importer claims a row by. A wrong one does not look wrong — it reprices
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
  /** The stored identifier pair (#1743); `kind: null` is a preserved import. */
  securityId?: StoredSecurityId;
  providerSymbol?: string;
}

/** What the chat declares. Blank/missing means «not declared». */
export interface InstrumentIdentityDeclaration {
  securityId?: SecurityId | null | undefined;
  providerSymbol?: string | null | undefined;
}

/** Only the fields being filled travel — never a full metadata replace. */
export interface InstrumentIdentityPatch {
  securityId?: SecurityId;
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

/**
 * The canonical form of a declared identifier, or the refusal to say out loud.
 * Validation is the domain's per-kind write boundary, so the chat refuses with
 * the SAME words the ficha does — including the `F####` guidance a partícipe
 * reading the wrong line of their paper needs (#1742).
 */
function normalizedDeclaration(
  securityId: SecurityId,
): { ok: true; value: SecurityId } | { ok: false; error: string } {
  const declared = securityId.value.trim();
  try {
    const value = normalizedSecurityIdColumnValue(securityId.kind, declared);
    return value === null
      ? { error: "La corrección de identidad no cambia nada.", ok: false }
      : { ok: true, value: { kind: securityId.kind, value } };
  } catch (error) {
    const guidance = error instanceof Error ? error.message : String(error);
    // The chat echoes what it refuses: the user typed it in prose, and seeing it
    // back is how they spot the typo. The `F####` guidance already names it.
    return {
      error: guidance.toUpperCase().includes(declared.toUpperCase())
        ? guidance
        : `«${declared}» no me sirve. ${guidance}`,
      ok: false,
    };
  }
}

/** Two identifiers name the same security only when kind AND value agree. */
function sameSecurityId(left: SecurityId | null, right: SecurityId | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.kind === right.kind &&
    left.value === right.value
  );
}

/**
 * What a holding claims. A stored value with a null kind (the preserved import of
 * #1416) is classified by shape here rather than ignored: it still points at a
 * security, and handing its identifier to a second holding is exactly the
 * collision this module refuses.
 */
function claimedSecurityId(holding: InstrumentIdentityHolding): SecurityId | null {
  return (
    declaredSecurityId(holding.securityId) ??
    classifySecurityId(holding.securityId?.value)
  );
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
  const declaredSymbol = normalizeSymbol(input.declaration.providerSymbol);
  const declaration = input.declaration.securityId ?? null;
  if (declaration === null && declaredSymbol === null) {
    return { ok: false, error: "La corrección de identidad no cambia nada." };
  }

  const currentSecurityId = claimedSecurityId(target);
  const currentSymbol = normalizeSymbol(target.providerSymbol);
  const rivals = input.portfolio.filter((holding) => holding.id !== target.id);
  const patch: InstrumentIdentityPatch = {};

  if (declaration !== null) {
    const label = SECURITY_ID_KIND_LABEL_INLINE[declaration.kind];
    // The shape check comes FIRST: a garbage declaration must be told apart from a
    // field that is already occupied, or the refusal names the wrong problem.
    const normalized = normalizedDeclaration(declaration);
    if (!normalized.ok) return { error: normalized.error, ok: false };
    const declaredSecurity = normalized.value;

    if (sameSecurityId(currentSecurityId, declaredSecurity)) {
      return {
        ok: false,
        error: `«${target.name}» ya tiene ese ${label} (${declaredSecurity.value}): no hay nada que corregir.`,
      };
    }
    if (currentSecurityId !== null) {
      return {
        ok: false,
        error: occupiedRejection({
          current: currentSecurityId.value,
          declared: declaredSecurity.value,
          holdingName: target.name,
          label: `el ${SECURITY_ID_KIND_LABEL_INLINE[currentSecurityId.kind]}`,
        }),
      };
    }
    const claimant = rivals.find((holding) =>
      sameSecurityId(claimedSecurityId(holding), declaredSecurity),
    );
    if (claimant) {
      return {
        ok: false,
        error: claimedRejection({
          claimantName: claimant.name,
          label: `El ${label}`,
          value: declaredSecurity.value,
        }),
      };
    }
    patch.securityId = declaredSecurity;
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
    // A symbol claimed by a neighbour is NOT refused, unlike a duplicated identifier.
    // The same ETF at two brokers shares its symbol legitimately, both holdings
    // price correctly off the same quote, and the symbol is precisely what an
    // unpriced holding is missing — refusing it would send the most common fill of
    // all to the ficha. What a duplicated identifier does and this does not is give an
    // importer a second claimant for a row it may overwrite (ADR 0055, #1366).
    patch.providerSymbol = declaredSymbol;
  }

  return { ok: true, patch };
}
