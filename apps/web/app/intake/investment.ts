import {
  normalizeDecimalString,
  normalizeNonNegativeDecimalString,
  parseMoneyMinor,
} from "@web/intake-primitives";
import type { CreateInvestmentAssetInput } from "@worthline/db";
import type {
  CreateInvestmentOperationInput,
  DecimalString,
  Instrument,
  InvestmentPriceProvider,
  LiquidityTier,
  Member,
  OperationKind,
  SecurityId,
  SecurityIdKind,
  StoredSecurityId,
} from "@worthline/domain";
import {
  instrumentLabelEs,
  isAssignableInstrumentForShape,
  isCaptureCurrency,
  isInstrument,
  isInvestmentPriceProvider,
  isValidIsin,
  normalizedSecurityIdColumnValue,
  SECURITY_ID_KIND_LABEL_INLINE,
  securityIdFieldForInstrument,
} from "@worthline/domain";
import { createStableId, parseOwnership, type StrictParseResult } from "./shared";

/**
 * Investment intake parsers (#241 stage 2). Turns the /inversiones/nueva,
 * route-scoped operation, and edit-investment forms into validated domain
 * command objects. Pure and framework-agnostic.
 */

// Re-export the type needed by #58 inversiones functions and consumers.
export type { CreateInvestmentAssetInput };

/**
 * Strict investment asset parser for /inversiones/nueva: requires a name,
 * rejects a manual price that cannot be parsed (instead of silently dropping
 * it to 0). Returns an error on first violation.
 */
export function parseInvestmentAssetCommandStrict(
  formData: FormData,
  members: Member[],
  seed: number,
): StrictParseResult<CreateInvestmentAssetInput> {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { ok: false, error: "El nombre de la inversión es obligatorio." };
  }

  const manualPriceRaw = String(formData.get("manualPricePerUnit") ?? "").trim();
  let manualPrice: DecimalString | undefined;

  if (manualPriceRaw) {
    const normalized = normalizeNonNegativeDecimalString(manualPriceRaw);

    if (normalized === null) {
      return {
        ok: false,
        error:
          "El precio manual no es válido. Introduce un número positivo o déjalo en blanco.",
      };
    }

    if (normalized !== "0") {
      manualPrice = normalized as DecimalString;
    }
  }

  const unitSymbol = String(formData.get("unitSymbol") ?? "").trim();
  const securityId = parseOptionalSecurityId(
    declaredSecurityIdKind(formData) ?? "isin",
    formData.get("securityId"),
  );
  const liquidityTier = parseCreateInvestmentLiquidityTier(formData.get("liquidityTier"));
  const priceProvider = parseInvestmentPriceProvider(formData.get("priceProvider"));
  const providerSymbol = String(formData.get("providerSymbol") ?? "").trim();

  if (!securityId.ok) {
    return { ok: false, error: securityId.error };
  }

  if (!liquidityTier) {
    return { ok: false, error: "La liquidez de la inversión no es válida." };
  }

  if (priceProvider === null) {
    return { ok: false, error: "El proveedor de precios no es válido." };
  }

  return {
    ok: true,
    command: {
      currency: "EUR",
      id: createStableId("asset", name, seed),
      liquidityTier,
      name,
      ownership: parseOwnership(formData, members),
      ...(manualPrice !== undefined ? { manualPricePerUnit: manualPrice } : {}),
      ...(unitSymbol ? { unitSymbol } : {}),
      ...(securityId.securityId ? { securityId: securityId.securityId } : {}),
      ...(priceProvider ? { priceProvider } : {}),
      ...(providerSymbol ? { providerSymbol } : {}),
    },
  };
}

/**
 * The ISIN a form carries, normalized — or a refusal (#1489).
 *
 * Two jobs, both boundary work. It UPPERCASES and strips whitespace, because the ISIN is
 * the instrument's identity key (`isin ?? providerSymbol`, ADR 0055/#539) and it is
 * compared as text: `ie00b52mjy50` typed by hand would be a second identity for the same
 * ETF, invisible to the statement merge and to the exposure catalog. And it REFUSES a
 * value that fails the ISO 6166 check digit, which the field could not produce while it
 * was a hidden input the symbol search filled — a human types now, and a stored typo is
 * an identity that will never match anything, silently, forever.
 *
 * Blank stays blank: the ISIN is optional by design (a pension plan often has none), and
 * an alta that leaves it empty is flagged by the health signal, never blocked.
 *
 * Exported because the alta is no longer the only door an ISIN comes through: the
 * traspaso form creates its destination holding in the same submit (#1480), and a
 * second reading of the same field would be a second identity rule.
 */
export function parseOptionalIsin(
  value: FormDataEntryValue | null,
): { ok: true; isin?: string } | { ok: false; error: string } {
  const normalized = String(value ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();

  if (!normalized) {
    return { ok: true };
  }

  if (!isValidIsin(normalized)) {
    return {
      ok: false,
      error:
        "El ISIN no es válido. Son 12 caracteres (p. ej. IE00B52MJY50); revísalo o déjalo en blanco.",
    };
  }

  return { ok: true, isin: normalized };
}

/**
 * The identifier field's write boundary, per instrument (#1746, decisión 9).
 *
 * One field, two vocabularies: a pension plan is identified by its DGS code
 * (`N5394`), everything else that HAS an identity by its ISIN. Which one is asked
 * for is the instrument's business (`securityIdFieldForInstrument`), so the box in
 * front of the user and the rule that accepts what he typed can never disagree —
 * the disagreement was #1489's impossible task, and the plan that stored its code
 * as an ISIN was the state #1745 could see but not warn about.
 *
 * Validation is the DOMAIN's per-kind boundary, the same call the assistant's fill
 * makes (#1349), so every door refuses with the same words — including the `F####`
 * guidance a partícipe reading the wrong line of their paper needs.
 *
 * Blank stays blank: the identifier is optional by design and «identificado, sin
 * cotizar» is a legitimate state (invariante 6 del PRD #1741). What is never
 * legitimate is a value stored under a kind it does not belong to.
 */
export function parseOptionalSecurityId(
  kind: SecurityIdKind,
  value: FormDataEntryValue | null,
): { ok: true; securityId?: SecurityId } | { ok: false; error: string } {
  try {
    const normalized = normalizedSecurityIdColumnValue(kind, String(value ?? ""));

    return normalized === null
      ? { ok: true }
      : { ok: true, securityId: { kind, value: normalized } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What a ficha save must NOT delete: the identifier its form could not show.
 *
 * `updateInvestmentAsset` is form-shaped — it nulls every metadata column it is not
 * given — so «the field was absent» and «the user cleared the field» reach the store
 * as the same thing. They are not the same thing, and #1743 already paid for the
 * confusion with a stopgap: the ficha only knew how to show an ISIN, so saving a
 * plan's ficha would drop the DGS code the v70 migration had just written it, and
 * nothing would say so.
 *
 * The rule is «a form that did not ask cannot answer», in three cases:
 *
 * - the box was rendered for THIS kind and came back blank → the user cleared it,
 *   and the identifier goes;
 * - no box at all (an instrument that carries no identifier, so the form declared
 *   no kind) → whatever is stored rides through untouched;
 * - a box of ANOTHER kind (a plan whose row still holds an ISIN, or a value the
 *   import preserved with NO kind at all) → it was rendered empty next to a line
 *   quoting the stored value, so a blank submit is not an answer about it either.
 *
 * The untyped case (`kind: null`, born only of the document import, #1416) is the
 * half #1770 closed. No box can ever ASK for it — a form field asks by kind — so it
 * is preserved through every save until the user types the good identifier over it,
 * which is exactly the repair salud de datos sends him here to make. Dropping it
 * left the row warned about and the user with no clue left to read.
 */
export function securityIdToWriteFromFicha({
  formData,
  stored,
  submitted,
}: {
  formData: FormData;
  stored: StoredSecurityId | undefined;
  /** What the form's own field parsed to, when it carried one. */
  submitted: SecurityId | undefined;
}): StoredSecurityId | undefined {
  if (submitted) return submitted;
  if (!stored) return undefined;

  // Only a box of the stored value's OWN kind speaks for it. `null` on either side
  // is not a match: no box at all answers nothing, and no box asks by «sin clase».
  const declared = declaredSecurityIdKind(formData);

  return declared !== null && stored.kind === declared ? undefined : stored;
}

/** The kind the FORM was rendered with, when it says so (a hidden declaration). */
function declaredSecurityIdKind(formData: FormData): SecurityIdKind | null {
  const raw = String(formData.get("securityIdKind") ?? "").trim();

  return raw === "isin" || raw === "dgs" ? raw : null;
}

/**
 * Route-scoped operation parser: the asset id comes from the URL route
 * (not a dropdown), preventing silent no-op on unselected dropdown.
 * Never silently swallows a bad units/price/fees field — returns an error
 * that names the offending field.
 *
 * `seed` is what makes the operation id unique. A clock reading gives a fresh id
 * per call; an idempotency key (#1394) gives the SAME id for the same submission,
 * which is how a double submit stops becoming two operations.
 */
export function parseRouteOperationCommand(
  formData: FormData,
  routeAssetId: string,
  seed: number | string,
  today: string,
): StrictParseResult<CreateInvestmentOperationInput> {
  const unitsRaw = String(formData.get("units") ?? "").trim();
  const priceRaw = String(formData.get("pricePerUnit") ?? "").trim();

  if (!unitsRaw) {
    return { ok: false, error: "Las unidades son obligatorias." };
  }

  if (!priceRaw) {
    return { ok: false, error: "El precio por unidad es obligatorio." };
  }

  const normalizeOperationDecimal = (raw: string): DecimalString =>
    normalizeDecimalString(raw, { allowNegative: true, fallback: "0" }) as DecimalString;

  const units = normalizeOperationDecimal(unitsRaw);
  const pricePerUnit = normalizeOperationDecimal(priceRaw);

  if (units === "0") {
    return { ok: false, error: "Las unidades deben ser un número positivo." };
  }

  if (pricePerUnit === "0" && priceRaw !== "0" && priceRaw !== "0,00") {
    return { ok: false, error: "El precio por unidad no es válido." };
  }

  const feesRaw = String(formData.get("fees") ?? "0");
  const feesMinor = parseMoneyMinor(feesRaw);

  if (feesMinor === null || feesMinor < 0) {
    return { ok: false, error: "Las comisiones no son válidas." };
  }

  const kind: OperationKind = formData.get("kind") === "sell" ? "sell" : "buy";
  const executedAt = String(formData.get("executedAt") ?? "").trim() || today;

  // The currency the apunte was CAPTURED in (#1401). A blank field is EUR — the
  // pre-#1401 behavior, byte for byte, which is what keeps the no-JS path and every
  // caller that never asks working unchanged. Anything outside the closed vocabulary
  // is refused rather than coerced: a currency the money model cannot represent would
  // mangle the fees by ×100 in silence.
  //
  // Nothing is converted here. This parser is pure and the ECB rate is a fetch, so it
  // stamps what was typed and `recordOperationAction` converts before persisting.
  const currency = String(formData.get("currency") ?? "").trim() || "EUR";

  if (!isCaptureCurrency(currency)) {
    return { ok: false, error: "Esa divisa no es válida para una operación." };
  }

  return {
    ok: true,
    command: {
      assetId: routeAssetId,
      currency,
      executedAt,
      feesMinor,
      id: createStableId("op", `${routeAssetId}_${kind}`, seed),
      kind,
      pricePerUnit,
      units,
    },
  };
}

/**
 * Edit investment parser: strict name required, manual price rejected when
 * unparseable (not silently dropped to 0).
 */
export function parseUpdateInvestmentCommand(
  formData: FormData,
  assetId: string,
): StrictParseResult<{
  id: string;
  name: string;
  instrument?: Instrument;
  liquidityTier?: LiquidityTier;
  unitSymbol?: string;
  securityId?: SecurityId;
  priceProvider?: InvestmentPriceProvider;
  providerSymbol?: string;
  manualPricePerUnit?: DecimalString;
}> {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { ok: false, error: "El nombre de la inversión es obligatorio." };
  }

  // #1512: the ficha may correct the instrument, but only within the shape it
  // already has. This route serves the `investment` shape by construction (the
  // ficha dispatches on the valuation method), so it asks the same domain gate as
  // the asset action, keyed by that shape instead of by a row it cannot read.
  const instrumentRaw = String(formData.get("instrument") ?? "").trim();
  if (
    instrumentRaw &&
    (!isInstrument(instrumentRaw) ||
      !isAssignableInstrumentForShape("investment", instrumentRaw))
  ) {
    return {
      ok: false,
      error:
        "No se puede reclasificar a ese tipo: se valora de otra forma. Para eso hay que darlo de alta de nuevo.",
    };
  }
  const instrument = isInstrument(instrumentRaw) ? instrumentRaw : undefined;

  const manualPriceRaw = String(formData.get("manualPricePerUnit") ?? "").trim();
  let manualPrice: DecimalString | undefined;

  if (manualPriceRaw) {
    const normalized = normalizeNonNegativeDecimalString(manualPriceRaw);

    if (normalized === null) {
      return {
        ok: false,
        error:
          "El precio manual no es válido. Introduce un número positivo o déjalo en blanco.",
      };
    }

    if (normalized !== "0") {
      manualPrice = normalized as DecimalString;
    }
  }

  const unitSymbol = String(formData.get("unitSymbol") ?? "").trim();
  const securityId = parseFichaSecurityId(formData, instrument);
  const liquidityTier = parseUpdateInvestmentLiquidityTier(formData.get("liquidityTier"));
  const priceProvider = parseInvestmentPriceProvider(formData.get("priceProvider"));
  const providerSymbol = String(formData.get("providerSymbol") ?? "").trim();

  if (!securityId.ok) {
    return { ok: false, error: securityId.error };
  }

  if (liquidityTier === null) {
    return { ok: false, error: "La liquidez de la inversión no es válida." };
  }

  if (priceProvider === null) {
    return { ok: false, error: "El proveedor de precios no es válido." };
  }

  return {
    ok: true,
    command: {
      id: assetId,
      name,
      ...(instrument ? { instrument } : {}),
      ...(liquidityTier ? { liquidityTier } : {}),
      ...(manualPrice !== undefined ? { manualPricePerUnit: manualPrice } : {}),
      ...(unitSymbol ? { unitSymbol } : {}),
      ...(securityId.securityId ? { securityId: securityId.securityId } : {}),
      ...(priceProvider ? { priceProvider } : {}),
      ...(providerSymbol ? { providerSymbol } : {}),
    },
  };
}

/**
 * The ficha's identifier field, validated against the instrument being SAVED —
 * which is not always the one the form was rendered with: the picker may be
 * correcting it in the same submit (#1512). A reclassification into a plan
 * therefore refuses the ISIN still sitting in the box, and says why, instead of
 * storing an identifier that identifies nothing (invariante 3 del PRD #1741).
 *
 * An instrument with NO identifier (crypto) ignores the field rather than
 * validating it: there is no box for it on that ficha, and an empty string is not
 * a declaration.
 */
function parseFichaSecurityId(
  formData: FormData,
  instrument: Instrument | undefined,
): { ok: true; securityId?: SecurityId } | { ok: false; error: string } {
  const declared = declaredSecurityIdKind(formData);
  const field = instrument ? securityIdFieldForInstrument(instrument) : null;

  if (instrument && !field) {
    return { ok: true };
  }

  const kind = field?.kind ?? declared ?? "isin";
  const parsed = parseOptionalSecurityId(kind, formData.get("securityId"));
  // The box was rendered for one kind and the picker is saving another, so the
  // value in it was never meant for this rule. Naming the change is what keeps the
  // refusal from reading as the app forgetting what an ISIN is.
  const reclassified = Boolean(instrument) && declared !== null && declared !== kind;

  if (parsed.ok || !reclassified) {
    return parsed;
  }

  return {
    ok: false,
    error:
      `Al reclasificarlo como ${instrumentLabelEs(instrument!).toLowerCase()}, su ` +
      `identificador es el ${SECURITY_ID_KIND_LABEL_INLINE[kind]} y no el ` +
      `${SECURITY_ID_KIND_LABEL_INLINE[declared!]}. ${parsed.error}`,
  };
}

function parseCreateInvestmentLiquidityTier(
  value: FormDataEntryValue | null,
): LiquidityTier | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "market";

  return isLiquidityTier(raw) ? raw : null;
}

function parseUpdateInvestmentLiquidityTier(
  value: FormDataEntryValue | null,
): LiquidityTier | null | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  return isLiquidityTier(raw) ? raw : null;
}

function isLiquidityTier(value: string): value is LiquidityTier {
  return (
    value === "cash" ||
    value === "market" ||
    value === "term-locked" ||
    value === "illiquid"
  );
}

/**
 * Parse a submitted price provider: `undefined` for an absent field, `null` for a
 * value outside the vocabulary. Accepts RETIRED providers (#1354) on purpose —
 * the edit form re-submits whatever a legacy holding already carries, and
 * rejecting it here would refuse a save that changes something else entirely.
 * The retired provider simply never fetches (see `retiredPriceProvider`).
 */
function parseInvestmentPriceProvider(
  value: FormDataEntryValue | null,
): InvestmentPriceProvider | null | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;

  return isInvestmentPriceProvider(raw) ? raw : null;
}
