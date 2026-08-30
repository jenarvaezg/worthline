/**
 * The alta of an inversión (#1611): the derived family — a fund, an ETF, a
 * stock, an index, a pension plan, a crypto rung. Its value is units × price and
 * the provider comes from the instrument catalog, never from a form dropdown.
 *
 * What makes this a family of its own is not the asset row — it is HOW MUCH YOU
 * HAVE. The simple drawer offers three mutually-exclusive answers (#597, #1541),
 * and each writes a different thing, or nothing at all:
 *
 * - **«Saldo de hoy»** → a synthetic opening BUY at the declared date (#1395),
 *   so the holding lands valued instead of as the 0 € container the alta used to
 *   create.
 * - **«Viene traspasada de otra entidad»** → ONE `transfer_in` with no pair, its
 *   outgoing half living in another institution's ledger. Never an opening BUY:
 *   a purchase would eat a year of contribution allowance (ADR 0080) for capital
 *   that merely changed manager — the miscount that printed «te has pasado
 *   2.127 €» in Jorge's cupo — and claim a plusvalía the ledger never earned.
 * - **«Importar extracto»** → nothing here; the broker CSV's historical orders
 *   are the only operations (#173), and the alta continues on the ficha.
 *
 * Both captures RESOLVE before anything is written. The alta is one unit of work
 * (#1599): a refused capture must never be answered with an error beside a fondo
 * already sitting in the tablero at 0 €.
 */

import type { ExposureCatalogStubCandidate } from "@web/ensure-exposure-catalog-stubs";
import {
  createStableId,
  mapDomainViolation,
  parseInvestmentAssetCommandStrict,
  parseRouteOperationCommand,
} from "@web/intake";
import type { ExternalTransferCaptureResult as ExternalTransferCapture } from "@web/patrimonio/anadir/external-transfer-in";
import { resolveExternalTransferCapture } from "@web/patrimonio/anadir/external-transfer-in";
import {
  parseOpeningCostMode,
  resolveOpeningCapture,
} from "@web/patrimonio/anadir/investment-units";
import type { InvestmentHoldingEntry } from "@worthline/db";
import type {
  InstrumentPriceProvider,
  InvestmentOperation,
  LiquidityTier,
} from "@worthline/domain";
import { checkOwnershipSplit, createInvestmentOperationSafe } from "@worthline/domain";
import type { AltaContext, AltaResult } from "./alta-contract";
import {
  carry,
  carryOwnership,
  requireWorkspace,
  SHARED_REFILL_FIELDS,
} from "./alta-form";

/** What the inversión pane posts and gets back after a rejected alta. */
export const INVESTMENT_REFILL_FIELDS: readonly string[] = [
  ...SHARED_REFILL_FIELDS,
  "symbol",
  "isin",
  "price",
  // The simple drawer's capture fields (#597) and the mode that selects them.
  "invMode",
  "saldo",
  "saldoDate",
  // The acquisition cost and how it was stated (#1490): a refused capture must
  // come back with them typed, or the user re-enters the one figure he had to
  // look up.
  "cost",
  "costMode",
  // «Viene traspasada de otra entidad» (#1541): the importe that arrived, the day
  // it landed, that day's VL and the inherited cost. Three of the four are looked
  // up in the old provider's paperwork.
  "trAmount",
  "trDate",
  "trPrice",
  "trCost",
];

/** The catalog facts the routing already resolved for this family. */
export interface InvestmentAltaSpec {
  priceProvider?: InstrumentPriceProvider;
  rung: LiquidityTier;
}

/**
 * The drawer's exclusive «how much you have» modes (#597, #1541). They are
 * mutually exclusive by construction, which is what keeps a synthetic apertura
 * from ever landing next to a real entry.
 */
type InvMode = "import" | "saldo" | "traspaso";

function parseInvMode(value: FormDataEntryValue | null): InvMode | null {
  const raw = String(value ?? "").trim();
  return raw === "saldo" || raw === "import" || raw === "traspaso" ? raw : null;
}

/** Re-scope the unified form to the names `parseInvestmentAssetCommandStrict` reads. */
function scopedInvestmentForm(ctx: AltaContext, spec: InvestmentAltaSpec): FormData {
  const scoped = new FormData();
  carry(ctx.formData, scoped, `name_${ctx.instrument}`, "name");
  carry(ctx.formData, scoped, `symbol_${ctx.instrument}`, "providerSymbol");
  carry(ctx.formData, scoped, `isin_${ctx.instrument}`, "isin");
  carry(ctx.formData, scoped, `price_${ctx.instrument}`, "manualPricePerUnit");
  scoped.set("liquidityTier", spec.rung);
  if (spec.priceProvider) {
    scoped.set("priceProvider", spec.priceProvider);
  }
  carryOwnership(ctx.formData, scoped);

  return scoped;
}

/**
 * Resolve the opening BUY for the «saldo de hoy» path (#597): the already-derived
 * units × price, dated at the resolved «Fecha del saldo» (today unless the user
 * said otherwise, #1395). Returns the operation the alta will write, or a Spanish
 * message on a domain violation.
 *
 * It RESOLVES and does not write. `today` stays the ripple's anchor — the
 * frontier between history and the daily capture — while the capture's own
 * `executedAt` is the date the saldo was read at; a backdated one makes the
 * ripple rebuild the snapshots from that day (ADR 0012 / 0020).
 */
function resolveOpeningOperation(
  assetId: string,
  opening: { units: string; price: string; executedAt: string },
  seed: number,
  today: string,
): { ok: true; operation: InvestmentOperation } | { ok: false; error: string } {
  const opForm = new FormData();
  opForm.set("units", opening.units);
  opForm.set("pricePerUnit", opening.price);
  opForm.set("kind", "buy");
  opForm.set("executedAt", opening.executedAt);

  const parsedOp = parseRouteOperationCommand(opForm, assetId, seed, today);

  if (!parsedOp.ok) {
    return { ok: false, error: parsedOp.error };
  }

  const safe = createInvestmentOperationSafe({ ...parsedOp.command, source: "opening" });

  if (!safe.ok) {
    return { ok: false, error: mapDomainViolation(safe.violations[0]) };
  }

  return { ok: true, operation: safe.value };
}

/**
 * The «alta por traspaso externo» entry (#1541): ONE `transfer_in` with no pair.
 * The ids are minted off the holding's own id, so a `transferId` of its own is
 * all the pairing readers need to find a single row and say «desde otra entidad»
 * (#1481) instead of reporting a broken pair (ADR 0083, decisión 7).
 *
 * No `source: "opening"` — the row keeps the store's «manual». That mark means
 * «synthetic apertura the alta invented» and is what `replaceOpening` is allowed
 * to drop; this row is a fact the user declared, with its own date and its own
 * inherited cost, and a statement import must not be able to sweep it away.
 */
function externalTransferEntry(
  assetId: string,
  entry: Extract<ExternalTransferCapture, { ok: true }>,
  seed: number,
): Extract<InvestmentHoldingEntry, { kind: "external_transfer_in" }> {
  return {
    kind: "external_transfer_in",
    transfer: {
      amountMinor: entry.amountMinor,
      destinationPricePerUnit: entry.pricePerUnit,
      executedAt: entry.executedAt,
      inheritedCostMinor: entry.inheritedCostMinor,
      inOperationId: createStableId("op", `${assetId}_transfer_in`, seed),
      transferId: createStableId("trf", assetId, seed),
    },
  };
}

export async function runInvestmentAlta(
  ctx: AltaContext,
  spec: InvestmentAltaSpec,
): Promise<AltaResult> {
  const scoped = scopedInvestmentForm(ctx, spec);
  const invMode = parseInvMode(ctx.formData.get(`invMode_${ctx.instrument}`));

  // The whole capture is resolved up-front (pure) — units (€ ÷ precio), the date
  // they are stamped with, and the price the opening carries (the declared
  // acquisition cost, or today's price when there is none — #1490) — so a missing
  // saldo/price, an impossible date or an unreadable cost fails BEFORE anything
  // is persisted: no orphaned 0 € holding, no operation dated on a day the
  // calendar does not have.
  const opening =
    invMode === "saldo"
      ? resolveOpeningCapture({
          costMode: parseOpeningCostMode(
            String(ctx.formData.get(`costMode_${ctx.instrument}`) ?? ""),
          ),
          costRaw: String(ctx.formData.get(`cost_${ctx.instrument}`) ?? ""),
          dateRaw: String(ctx.formData.get(`saldoDate_${ctx.instrument}`) ?? ""),
          priceRaw: String(scoped.get("manualPricePerUnit") ?? ""),
          saldoRaw: String(ctx.formData.get(`saldo_${ctx.instrument}`) ?? ""),
          today: ctx.today,
        })
      : null;

  if (opening && !opening.ok) {
    return { ok: false, message: opening.error };
  }

  // Resolved the same way and for the same reason. `resolveExternalTransferCapture`
  // runs `planExternalTransferIn`, the gate's own plan, so what is checked here is
  // exactly what the gate will check again.
  const external =
    invMode === "traspaso"
      ? resolveExternalTransferCapture({
          amountRaw: String(ctx.formData.get(`trAmount_${ctx.instrument}`) ?? ""),
          costRaw: String(ctx.formData.get(`trCost_${ctx.instrument}`) ?? ""),
          dateRaw: String(ctx.formData.get(`trDate_${ctx.instrument}`) ?? ""),
          priceRaw: String(ctx.formData.get(`trPrice_${ctx.instrument}`) ?? ""),
          today: ctx.today,
        })
      : null;

  if (external && !external.ok) {
    return { ok: false, message: external.error };
  }

  // A plan brought over from another manager is the case with NO provider quote —
  // Finect may not carry it, and nobody will ever quote a hand-created one — so
  // the VL the user just declared becomes the holding's manual price. Without it
  // the alta would land in the list worth 0 € (#1490's lesson).
  //
  // It OVERWRITES whatever the saldo pane's price field carries, rather than only
  // filling a blank: every pane posts even while hidden (ADR 0009), so that field
  // may hold a live quote or a keystroke left over from before the mode was
  // switched, and the two are indistinguishable here. A real quote is unaffected:
  // a cached price beats a manual one at read time (ADR 0006), so this only
  // decides what a holding nobody quotes is worth.
  if (external?.ok) {
    scoped.set("manualPricePerUnit", external.pricePerUnit);
  }

  const found = await requireWorkspace(ctx);

  if (!found.ok) {
    return found;
  }

  const { workspace } = found;
  const parsed = parseInvestmentAssetCommandStrict(scoped, workspace.members, ctx.seed);

  if (!parsed.ok) {
    return { ok: false, message: parsed.error };
  }

  const splitViolation = checkOwnershipSplit(workspace, parsed.command.ownership);

  if (splitViolation) {
    return { ok: false, message: mapDomainViolation(splitViolation) };
  }

  const resolvedOpening = opening?.ok
    ? resolveOpeningOperation(parsed.command.id, opening, ctx.seed, ctx.today)
    : null;

  if (resolvedOpening && !resolvedOpening.ok) {
    return { ok: false, message: resolvedOpening.error };
  }

  const entry: InvestmentHoldingEntry | null = resolvedOpening
    ? { kind: "opening", operation: resolvedOpening.operation }
    : external?.ok
      ? externalTransferEntry(parsed.command.id, external, ctx.seed)
      : null;

  // ONE unit of work: the holding and the entry that values it commit or roll
  // back together (#1599). Before this seam the two were separate calls, so a
  // refused entry answered with an error and left the fondo in the tablero at 0 €.
  const created = await ctx.store.command.createInvestmentHolding({
    asset: { ...parsed.command, instrument: ctx.instrument },
    ...(entry ? { entry } : {}),
    today: ctx.today,
  });

  if (!created.ok) {
    return { ok: false, message: mapDomainViolation(created.violations[0]) };
  }

  // The catalog identity to register once the write commits (#1097), and the
  // pricing coordinates whose FIRST quote is asked for right after (#1314) — the
  // holding would otherwise sit unpriced until the 21:00 capture. Both ride the
  // created payload so they run in afterCommit, never inside the transaction.
  const catalog: ExposureCatalogStubCandidate = {
    displayName: parsed.command.name,
    instrument: ctx.instrument,
    isin: parsed.command.isin ?? null,
    priceProvider: parsed.command.priceProvider ?? null,
    providerSymbol: parsed.command.providerSymbol ?? null,
  };

  return {
    ok: true,
    created: {
      catalog,
      firstQuote: {
        asset: {
          currency: parsed.command.currency,
          id: parsed.command.id,
          ...(parsed.command.liquidityTier
            ? { liquidityTier: parsed.command.liquidityTier }
            : {}),
          ...(parsed.command.priceProvider
            ? { priceProvider: parsed.command.priceProvider }
            : {}),
          ...(parsed.command.providerSymbol
            ? { providerSymbol: parsed.command.providerSymbol }
            : {}),
        },
        nowIso: ctx.now,
      },
      holdingId: parsed.command.id,
      // «Importar extracto» continues on the ficha, where the CSV is loaded; the
      // traspaso says so in the confirmation, because what the user needs to read
      // back is not «creada» but «no la has comprado» (#1541).
      ...(invMode === "import"
        ? { landing: "holding-ficha" as const, okKey: "investment_import_ready" }
        : {
            okKey: external ? "investment_transfer_in_added" : "investment_added",
          }),
    },
  };
}
