"use server";

import { markFirstHoldingBestEffort } from "@web/activation-marks";
import {
  type ExposureCatalogStubCandidate,
  ensureExposureCatalogStubs,
} from "@web/ensure-exposure-catalog-stubs";
import { fetchFirstQuoteBestEffort } from "@web/first-quote";
import { formAction } from "@web/form-action";
import { holdingDetailHref } from "@web/holding-route";
import {
  acquisitionDatedToday,
  acquisitionTodayNotice,
  appendParam,
  createStableId,
  errorRedirectUrl,
  mapDomainViolation,
  parseAssetCommandStrict,
  parseInvestmentAssetCommandStrict,
  parseLiabilityCommand,
  parseMoneyMinorField,
  parseRouteOperationCommand,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import type { ExternalTransferCaptureResult as ExternalTransferCapture } from "@web/patrimonio/anadir/external-transfer-in";
import { resolveExternalTransferCapture } from "@web/patrimonio/anadir/external-transfer-in";
import {
  parseOpeningCostMode,
  resolveOpeningCapture,
} from "@web/patrimonio/anadir/investment-units";
import type { InvestmentHoldingEntry } from "@worthline/db";
import type {
  DebtModel,
  Instrument,
  InvestmentOperation,
  LiabilityType,
} from "@worthline/domain";
import {
  checkOwnershipSplit,
  createInvestmentOperationSafe,
  createLiabilitySafe,
  defaultsFor,
} from "@worthline/domain";
import type { InvestmentAssetRef } from "@worthline/pricing";
import { holdingBoardAnchor } from "./action-helpers";
import {
  CURRENT_STATE_DEBT_FIELD_NAMES,
  deriveCurrentStateDebt,
} from "./current-state-debt";
import { readDebtHistoryStarts } from "./debt-history-starts";
import { buildCurrentStateAmortization } from "./persist-current-state-debt";
import { persistManualAssetCreation } from "./persist-holding";

/**
 * The unified «Añadir holding» server action (issue #151, PRD #146 S5).
 *
 * The instrument-first add flow posts the chosen `instrument` plus that
 * instrument's fields, suffixed with `_<instrument>` so the hidden forms of the
 * other instruments (all present in the DOM for the CSS `:has()` disclosure) post
 * without colliding. This action reads ONLY the selected instrument's fields,
 * derives the holding's rung / valuation method / provider from the instrument
 * catalog (`defaultsFor`), and dispatches to the matching persistence path —
 * never trusting a "Tipo"/"Capa" the form might disagree on.
 */

/** Where the add flow returns on validation error. */
const ADD_URL = "/patrimonio/anadir";
const ADVANCED_ADD_URL = "/patrimonio/anadir/avanzado";

function parseReturnUrl(value: FormDataEntryValue | null): string {
  return String(value ?? "") === ADVANCED_ADD_URL ? ADVANCED_ADD_URL : ADD_URL;
}

type SimpleDrawer = "dinero" | "inmueble" | "bien" | "deuda" | "inversion";

function parseSimpleDrawer(value: FormDataEntryValue | null): SimpleDrawer | null {
  const raw = String(value ?? "").trim();
  return ["dinero", "inmueble", "bien", "deuda", "inversion"].includes(raw)
    ? (raw as SimpleDrawer)
    : null;
}

function copyFormData(formData: FormData): FormData {
  const copy = new FormData();
  for (const [key, value] of formData.entries()) {
    copy.append(key, value);
  }
  return copy;
}

function normalizeSimpleDrawerForm(
  formData: FormData,
  today: string,
): { formData: FormData; instrument: Instrument | null; unsupported?: string } {
  const drawer = parseSimpleDrawer(formData.get("simpleDrawer"));

  if (!drawer) {
    return { formData, instrument: parseInstrument(formData.get("instrument")) };
  }

  if (drawer === "inversion") {
    // The 3 behavior groups (#597): «Cotiza en bolsa»→fund, «Plan de pensiones»→
    // pension_plan, «Cripto»→crypto. The group radio posts the instrument directly,
    // and the pane already posts instrument-suffixed fields (name_/symbol_/price_/
    // saldo_/invMode_), so the derived path reads them with no remap.
    const instrument = parseInstrument(formData.get("instrument"));
    if (
      instrument !== "fund" &&
      instrument !== "pension_plan" &&
      instrument !== "crypto"
    ) {
      return {
        formData,
        instrument: null,
        unsupported: "Elige dónde está tu inversión: bolsa, plan de pensiones o cripto.",
      };
    }
    return { formData, instrument };
  }

  const normalized = copyFormData(formData);
  const simpleValueFor = (key: string): string =>
    String(formData.get(`${key}_${drawer}`) ?? formData.get(key) ?? "");
  const simpleName = simpleValueFor("simpleName");
  const simpleValue = simpleValueFor("simpleValue");
  const instrument =
    drawer === "dinero"
      ? formData.get("cashTerm_dinero") === "on" || formData.get("cashTerm") === "on"
        ? "term_deposit"
        : "current_account"
      : drawer === "inmueble"
        ? "property"
        : drawer === "bien"
          ? (parseInstrument(formData.get("simpleAssetKind")) ?? "other")
          : parseInstrument(formData.get("simpleDebtKind"));

  if (!instrument) {
    return { formData: normalized, instrument: null };
  }

  normalized.set("instrument", instrument);
  normalized.set(`name_${instrument}`, simpleName);

  if (drawer === "deuda") {
    normalized.set(`balance_${instrument}`, simpleValue);
  } else if (drawer === "inmueble") {
    normalized.set("acqDate_property", today);
    normalized.set("acqValue_property", simpleValue);
    if (
      formData.get("primaryResidence_inmueble") === "on" ||
      formData.get("primaryResidence") === "on"
    ) {
      normalized.set("isPrimaryResidence_property", "on");
    }
  } else {
    normalized.set(`value_${instrument}`, simpleValue);
  }

  return { formData: normalized, instrument };
}

const INSTRUMENTS: readonly Instrument[] = [
  "current_account",
  "term_deposit",
  "fund",
  "etf",
  "stock",
  "index",
  "pension_plan",
  "crypto",
  "precious_metal",
  "vehicle",
  "property",
  "other",
  "mortgage",
  "loan",
  "credit_card",
];

function parseInstrument(value: FormDataEntryValue | null): Instrument | null {
  const raw = String(value ?? "").trim();
  return (INSTRUMENTS as readonly string[]).includes(raw) ? (raw as Instrument) : null;
}

/**
 * The simple investment drawer's exclusive "how much you have" modes (#597), plus
 * the third one #1541 added: the position was not bought, it ARRIVED — «viene
 * traspasada de otra entidad». They are mutually exclusive by construction, which is
 * what keeps a synthetic apertura from ever landing next to a real entry.
 */
function parseInvMode(
  value: FormDataEntryValue | null,
): "saldo" | "import" | "traspaso" | null {
  const raw = String(value ?? "").trim();
  return raw === "saldo" || raw === "import" || raw === "traspaso" ? raw : null;
}

/**
 * Resolve the opening BUY for a derived investment coming in through the "saldo de
 * hoy" path (#597): the already-derived units × price, dated at the resolved
 * «Fecha del saldo» (today unless the user said otherwise, #1395). Returns the
 * operation the alta will write, or a Spanish message on a domain violation.
 *
 * It RESOLVES and does not write. The alta is one unit of work (#1599), so this
 * runs before the holding exists — a refused opening must never be answered with
 * an error beside a fondo already sitting in the tablero at 0 €. The asset id it
 * stamps is the one the submission has just derived, minted before either row.
 *
 * `today` stays the ripple's anchor — the frontier between history and the daily
 * capture — while the capture's own `executedAt` is the date the saldo was read at;
 * a backdated one makes the ripple rebuild the snapshots from that day (ADR 0012 /
 * 0020).
 */
function resolveOpeningOperation(
  assetId: string,
  opening: { units: string; price: string; executedAt: string },
  today: string,
): { ok: true; operation: InvestmentOperation } | { ok: false; error: string } {
  const opForm = new FormData();
  opForm.set("units", opening.units);
  opForm.set("pricePerUnit", opening.price);
  opForm.set("kind", "buy");
  opForm.set("executedAt", opening.executedAt);

  const parsedOp = parseRouteOperationCommand(opForm, assetId, Date.now(), today);

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
 * The «alta por traspaso externo» entry for a freshly-created investment (#1541):
 * ONE `transfer_in` with no pair, because its outgoing half lives in another
 * institution's ledger. Shaped here and written by the alta seam, in the same unit
 * of work as the holding it values (#1599).
 *
 * The ids are minted here off the holding's own id, which the alta has just derived
 * for this submission — one alta, one entry, so a `transferId` of its own is all the
 * pairing readers need to find a single row and say «desde otra entidad» (#1481).
 *
 * No `source: "opening"` — the row keeps the store's «manual». That mark means
 * «synthetic apertura the alta invented» and is what `replaceOpening` is allowed to
 * drop; this row is a fact the user declared, with its own date and its own inherited
 * cost, and a statement import must not be able to sweep it away.
 */
function externalTransferEntry(
  assetId: string,
  entry: Extract<ExternalTransferCapture, { ok: true }>,
): Extract<InvestmentHoldingEntry, { kind: "external_transfer_in" }> {
  // ONE clock reading for both ids, as everywhere else in this action. The wizard
  // does not post the submission key of #1394, so a double submit already mints two
  // holdings here and this entry rides whichever one it belongs to; giving the two
  // ids of ONE entry two different milliseconds would be gratuitous on top.
  const seed = Date.now();

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

/**
 * The debt model a `loan` is created with (#273): the user picks «Amortizable»
 * (a French-amortization plan, set up later in the ficha) or «Informal» (declared
 * balances, no plan/term/first-payment). Defaults to amortizable when the choice
 * is absent or unrecognized, preserving the pre-#273 behavior. Mortgage and
 * credit_card keep their fixed models — only the loan offers the choice.
 */
function parseLoanDebtModel(formData: FormData): DebtModel {
  return String(formData.get("debtModel_loan") ?? "").trim() === "informal"
    ? "informal"
    : "amortizable";
}

const FIELD_KEYS = [
  "name",
  "value",
  "symbol",
  "isin",
  "price",
  "acqDate",
  "acqValue",
  // What was disbursed to acquire the property (#1441). Refilled after a rejected
  // alta for the same reason the investment cost is: it comes off the escritura,
  // and re-typing it means going back to the paperwork.
  "acqCost",
  "rate",
  "balance",
  "assoc",
  "inheritOwnership",
  "debtModel",
  "isPrimaryResidence",
  // Simple investment drawer capture fields (#597), refilled after a validation error.
  "saldo",
  "saldoDate",
  // The acquisition cost and how it was stated (#1490): a refused capture must come
  // back with them typed, or the user re-enters the one figure he had to look up.
  "cost",
  "costMode",
  "invMode",
  // «Viene traspasada de otra entidad» (#1541): the importe that arrived, the day it
  // landed, that day's VL and the inherited cost. A refused entry must come back with
  // all four typed — three of them are looked up in the old provider's paperwork.
  "trAmount",
  "trDate",
  "trPrice",
  "trCost",
];

const SIMPLE_FIELD_KEYS = [
  "returnTo",
  "simpleDrawer",
  "simpleName",
  "simpleValue",
  "simpleName_dinero",
  "simpleValue_dinero",
  "cashTerm_dinero",
  "simpleName_inmueble",
  "simpleValue_inmueble",
  "primaryResidence_inmueble",
  "simpleName_bien",
  "simpleValue_bien",
  "simpleName_deuda",
  "simpleValue_deuda",
  "simpleAssetKind",
  "simpleDebtKind",
  // «Alta por estado actual» (ADR 0056, #677) — the debt drawer's default path.
  ...CURRENT_STATE_DEBT_FIELD_NAMES,
];

/** Copy a suffixed field onto a canonical name, when present. */
function carry(
  from: FormData,
  to: FormData,
  sourceKey: string,
  canonicalKey: string,
): void {
  const value = from.get(sourceKey);
  if (value !== null) {
    to.set(canonicalKey, String(value));
  }
}

/** Copy the shared ownership fields (canonical, not suffixed) onto the scoped form. */
function carryOwnership(from: FormData, to: FormData): void {
  for (const [key, value] of from.entries()) {
    if (
      key === "ownershipPreset" ||
      key === "scopeMemberId" ||
      key.startsWith("owner_")
    ) {
      to.set(key, String(value));
    }
  }
}

/**
 * Re-scope the unified form to the canonical field names the asset parser
 * expects. The instrument's type and rung are injected (never read from a
 * dropdown — AC#4); ownership fields are shared (not suffixed) and copied through.
 */
function scopedAssetForm(
  formData: FormData,
  instrument: Instrument,
  assetType: "cash" | "manual" | "real_estate",
  rung: string,
): FormData {
  const scoped = new FormData();
  scoped.set("type", assetType);
  scoped.set("liquidityTier", rung);
  carry(formData, scoped, `name_${instrument}`, "name");
  carry(formData, scoped, `value_${instrument}`, "currentValue");
  carry(formData, scoped, `acqDate_${instrument}`, "acquisitionDate");
  carry(formData, scoped, `acqValue_${instrument}`, "acquisitionValue");
  carry(formData, scoped, `acqCost_${instrument}`, "acquisitionCost");
  carry(formData, scoped, `rate_${instrument}`, "rate");
  carry(formData, scoped, `isPrimaryResidence_${instrument}`, "isPrimaryResidence");
  carryOwnership(formData, scoped);

  return scoped;
}

/**
 * Re-scope the unified form for a derived investment. The provider and rung come
 * from the instrument catalog; the user's symbol and optional manual price are
 * carried from the suffixed fields.
 */
function scopedInvestmentForm(
  formData: FormData,
  instrument: Instrument,
  priceProvider: string | undefined,
  rung: string,
): FormData {
  const scoped = new FormData();
  carry(formData, scoped, `name_${instrument}`, "name");
  carry(formData, scoped, `symbol_${instrument}`, "providerSymbol");
  carry(formData, scoped, `isin_${instrument}`, "isin");
  carry(formData, scoped, `price_${instrument}`, "manualPricePerUnit");
  scoped.set("liquidityTier", rung);
  if (priceProvider) {
    scoped.set("priceProvider", priceProvider);
  }
  carryOwnership(formData, scoped);

  return scoped;
}

/** Re-scope the unified form for a debt instrument. */
function scopedLiabilityForm(
  formData: FormData,
  instrument: Instrument,
  type: LiabilityType,
): FormData {
  const scoped = new FormData();
  scoped.set("type", type);
  carry(formData, scoped, `name_${instrument}`, "name");
  carry(formData, scoped, `balance_${instrument}`, "balance");
  carry(formData, scoped, `assoc_${instrument}`, "associatedAssetId");
  carry(formData, scoped, `inheritOwnership_${instrument}`, "inheritOwnership");
  carryOwnership(formData, scoped);

  return scoped;
}

export async function createHoldingAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const returnUrl = parseReturnUrl(formData.get("returnTo"));
  return formAction<
    undefined,
    {
      redirectUrl: string;
      catalog?: ExposureCatalogStubCandidate;
      firstQuote?: { asset: InvestmentAssetRef; nowIso: string };
    }
  >({
    requireId: false,
    datedFact: false,
    guardUrl: () => returnUrl,
    run: async (store, { today, now }) => {
      const normalized = normalizeSimpleDrawerForm(formData, today);
      const actionFormData = normalized.formData;
      const instrument = normalized.instrument;

      if (!instrument) {
        return {
          ok: false,
          error: errorRedirectUrl(returnUrl, {
            formId: "holding",
            message: normalized.unsupported ?? "Elige un tipo de instrumento.",
            values: preserveFields(
              actionFormData,
              ["instrument", "ownershipPreset", "scopeMemberId", ...SIMPLE_FIELD_KEYS],
              ["owner_"],
            ),
          }),
        };
      }

      // On error, reopen the chosen pane and refill what was typed.
      const errorUrl = (message: string): string =>
        errorRedirectUrl(returnUrl, {
          formId: "holding",
          message,
          values: preserveFields(
            actionFormData,
            [
              "instrument",
              "ownershipPreset",
              "scopeMemberId",
              ...SIMPLE_FIELD_KEYS,
              ...FIELD_KEYS.map((k) => `${k}_${instrument}`),
            ],
            ["owner_"],
          ),
        });

      // S5 (#600): the simple wizard loops. A successful add returns to the wizard
      // with a success panel (the `ok` key + the new holding id as a query param the
      // server can read — the #anchor is client-only), so first runs chain adds
      // without friction. The avanzado flow keeps landing on the holdings list; the
      // investment-import route below is exempt (it goes to «Cargar movimientos»).
      // The holding is named by its public `wl_hld_…` id here (#1318) — both as
      // the `added=` param the success panel turns into a ficha link and as the
      // board anchor. Creation registers it, so the miss below is unreachable;
      // if it ever happens the alta still succeeded, so the screen drops the
      // ficha link (the panel already renders without one) rather than 500 over
      // a holding that is safely on disk.
      //
      // `params` carries the extra query params an ok-key's message reads (the
      // acquisition question's `deudaDesde`, #1561). They ride through
      // `appendParam`, which inserts before the `#anchor` instead of after it.
      //
      // `jumpToHolding: false` drops that `#anchor` on the /patrimonio landing:
      // when the redirect carries a QUESTION, scrolling straight to the new row
      // leaves the band that asks it off-screen above (#1561). The wizard's
      // `&added=` is untouched — it feeds the success panel's ficha link, not a
      // scroll position, and that panel IS the whole screen.
      const successUrl = async (
        okKey: string,
        id: string,
        options: {
          params?: Record<string, string>;
          jumpToHolding?: boolean;
        } = {},
      ): Promise<string> => {
        const publicId = await holdingBoardAnchor(store, id);
        const base =
          returnUrl === ADD_URL
            ? `${successRedirectUrl(ADD_URL, okKey)}${publicId ? `&added=${publicId}` : ""}`
            : successRedirectUrl(
                "/patrimonio",
                okKey,
                options.jumpToHolding === false ? undefined : publicId,
              );
        return Object.entries(options.params ?? {}).reduce(
          (url, [key, value]) => appendParam(url, key, value),
          base,
        );
      };

      // The catalog owns every per-instrument storage decision: the rung, valuation
      // method and provider, plus the legacy AssetType a stored asset persists as
      // and how a debt persists (its type + default model). The action only reads it.
      const defaults = defaultsFor(instrument);

      // Assets — stored (cash/manual) and appreciating (property). Reuse the strict
      // asset parser + shared persistence, stamping the chosen instrument.
      const assetType = defaults.assetType;

      if (assetType) {
        const scoped = scopedAssetForm(
          actionFormData,
          instrument,
          assetType,
          defaults.rung,
        );
        const workspace = await store.workspace.readWorkspace();

        if (!workspace) {
          return { ok: false, error: errorUrl("Workspace no inicializado.") };
        }

        const parsed = parseAssetCommandStrict(
          scoped,
          workspace.members,
          Date.now(),
          today,
        );

        if (!parsed.ok) {
          return { ok: false, error: errorUrl(parsed.error) };
        }

        // #1561: the acquisition date decides from WHEN the inmueble exists in the
        // histórico — and the simple drawer stamps TODAY without ever asking. If a
        // debt's own curve already starts earlier, that debt drops out of every
        // graph dated before today (#1436, the Plasencia case). Ask about it.
        // Read BEFORE the write (the fresh asset carries no debt of its own) and
        // only when the date is today's, so a historical alta pays nothing.
        const notice = acquisitionDatedToday({
          acquisitionDate: parsed.command.acquisitionDate,
          today,
        })
          ? acquisitionTodayNotice({
              acquisitionDate: parsed.command.acquisitionDate,
              debtStarts: await readDebtHistoryStarts(store),
              today,
            })
          : null;

        const result = await persistManualAssetCreation(
          store,
          workspace,
          { ...parsed.command, instrument },
          Date.now(),
          today,
        );

        if (!result.ok) {
          return { ok: false, error: errorUrl(result.error) };
        }

        return {
          ok: true,
          value: {
            redirectUrl: notice
              ? await successUrl("asset_added_acquisition_today", result.id, {
                  jumpToHolding: false,
                  params: { deudaDesde: notice.earliestDebtStart },
                })
              : await successUrl("asset_added", result.id),
          },
        };
      }

      // Derived investments — value is units × price; the provider comes from the
      // instrument (yahoo / finect / coingecko), not a form dropdown.
      if (defaults.valuationMethod === "derived") {
        const scoped = scopedInvestmentForm(
          actionFormData,
          instrument,
          defaults.priceProvider,
          defaults.rung,
        );
        // The simple investment drawer (#597) captures "how much you have" via one of
        // two mutually-exclusive modes; the avanzado flow posts neither and creates
        // the empty container exactly as before.
        const invMode = parseInvMode(actionFormData.get(`invMode_${instrument}`));

        // (a) "Saldo de hoy": resolve the whole capture up-front (pure) — units
        // (€ ÷ precio), the date they are stamped with («¿Desde cuándo la tienes?»,
        // today by default, #1395) and the price the opening carries (the declared
        // acquisition cost, or today's price when there is none — #1490) — so a
        // missing saldo/price, an impossible date or an unreadable cost fails BEFORE
        // anything is persisted: no orphaned 0 € holding, no operation dated on a day
        // the calendar does not have.
        const opening =
          invMode === "saldo"
            ? resolveOpeningCapture({
                costMode: parseOpeningCostMode(
                  String(actionFormData.get(`costMode_${instrument}`) ?? ""),
                ),
                costRaw: String(actionFormData.get(`cost_${instrument}`) ?? ""),
                dateRaw: String(actionFormData.get(`saldoDate_${instrument}`) ?? ""),
                priceRaw: String(scoped.get("manualPricePerUnit") ?? ""),
                saldoRaw: String(actionFormData.get(`saldo_${instrument}`) ?? ""),
                today,
              })
            : null;

        if (opening && !opening.ok) {
          return { ok: false, error: errorUrl(opening.error) };
        }

        // (c) «Viene traspasada de otra entidad» (#1541): resolved the same way and
        // for the same reason — the whole entry has to be readable BEFORE a holding
        // exists, or a refused traspaso leaves an empty 0 € investment behind. The
        // resolution runs `planExternalTransferIn`, the gate's own plan, so what is
        // checked here is exactly what the gate will check again.
        const external =
          invMode === "traspaso"
            ? resolveExternalTransferCapture({
                amountRaw: String(actionFormData.get(`trAmount_${instrument}`) ?? ""),
                costRaw: String(actionFormData.get(`trCost_${instrument}`) ?? ""),
                dateRaw: String(actionFormData.get(`trDate_${instrument}`) ?? ""),
                priceRaw: String(actionFormData.get(`trPrice_${instrument}`) ?? ""),
                today,
              })
            : null;

        if (external && !external.ok) {
          return { ok: false, error: errorUrl(external.error) };
        }

        // A plan brought over from another manager is the case with NO provider quote
        // — Finect may not carry it, and nobody will ever quote a hand-created one —
        // so the VL the user just declared becomes the holding's manual price. Without
        // it the alta would land in the list worth 0 € (#1490's lesson, and what
        // `recordTransferAction` already does for a destination it creates).
        //
        // It OVERWRITES whatever the saldo pane's price field carries, rather than
        // only filling a blank: every pane posts even while hidden (ADR 0009), so that
        // field may hold a live quote or a keystroke left over from before the mode
        // was switched, and the two are indistinguishable here. The declared VL is the
        // one price the user typed in the pane they actually chose. A real quote is
        // unaffected: a cached price beats a manual one at read time (ADR 0006), so
        // this only decides what a holding nobody quotes is worth.
        if (external?.ok) {
          scoped.set("manualPricePerUnit", external.pricePerUnit);
        }

        const workspace = await store.workspace.readWorkspace();

        if (!workspace) {
          return { ok: false, error: errorUrl("Workspace no inicializado.") };
        }

        const parsed = parseInvestmentAssetCommandStrict(
          scoped,
          workspace.members,
          Date.now(),
        );

        if (!parsed.ok) {
          return { ok: false, error: errorUrl(parsed.error) };
        }

        const splitViolation = checkOwnershipSplit(workspace, parsed.command.ownership);

        if (splitViolation) {
          return { ok: false, error: errorUrl(mapDomainViolation(splitViolation)) };
        }

        // The catalog identity to register once the write commits (#1097). Threaded
        // out on the run payload so the best-effort stub call runs in afterCommit —
        // after, and never inside, the workspace transaction.
        const catalog: ExposureCatalogStubCandidate = {
          displayName: parsed.command.name,
          instrument,
          isin: parsed.command.isin ?? null,
          priceProvider: parsed.command.priceProvider ?? null,
          providerSymbol: parsed.command.providerSymbol ?? null,
        };

        // The opening BUY at the saldo's date, so the holding lands valued — not the
        // 0 € container the alta used to create. Dated today unless the user said the
        // saldo is older (#1395), in which case the ripple reconstructs the history
        // from there: dating a weeks-old traspaso today left the net worth with a hole
        // between the exit and the re-entry. Never combined with (b) import: a
        // synthetic apertura would not match the CSV's historical orders (merge keys
        // on date) → a duplicate position; the mode exclusion prevents it (#597).
        //
        // Resolved BEFORE the holding exists: a refused opening is a message with no
        // fantasma behind it (#1599). The traspaso entry keeps its OWN kind — never
        // the opening BUY. A purchase would eat a year of contribution allowance
        // (ADR 0080) for capital that merely changed manager, which is exactly the
        // miscount that printed «te has pasado 2.127 €» in Jorge's cupo, and it would
        // claim a plusvalía the ledger never earned. The seam writes ONE `transfer_in`
        // carrying its own `transferId`, so the readers that pair by that id find a
        // single row and name it «desde otra entidad» (#1481) instead of reporting a
        // broken pair (ADR 0083, decisión 7).
        const resolvedOpening = opening?.ok
          ? resolveOpeningOperation(parsed.command.id, opening, today)
          : null;

        if (resolvedOpening && !resolvedOpening.ok) {
          return { ok: false, error: errorUrl(resolvedOpening.error) };
        }

        const entry: InvestmentHoldingEntry | null = resolvedOpening
          ? { kind: "opening", operation: resolvedOpening.operation }
          : external?.ok
            ? externalTransferEntry(parsed.command.id, external)
            : null;

        // ONE unit of work: the holding and the entry that values it commit or roll
        // back together (#1599). Before this seam the two were separate calls, so a
        // refused entry answered with an error and left the fondo in the tablero at
        // 0 €, with no operations.
        const created = await store.command.createInvestmentHolding({
          asset: { ...parsed.command, instrument },
          ...(entry ? { entry } : {}),
          today,
        });

        if (!created.ok) {
          return {
            ok: false,
            error: errorUrl(mapDomainViolation(created.violations[0])),
          };
        }

        // (b) "Importar extracto": no synthetic opening — route to «Cargar movimientos»
        // (#173) so the broker CSV's historical orders are the only operations.
        // «Importar extracto» routes straight to the ficha, so here the public id
        // IS the destination; without it there is no ficha URL to send anyone to
        // and the board is the honest landing.
        const importTarget = await holdingBoardAnchor(store, parsed.command.id);
        const redirectUrl =
          invMode === "import"
            ? successRedirectUrl(
                importTarget ? holdingDetailHref(importTarget) : "/patrimonio",
                "investment_import_ready",
              )
            : // The traspaso says so in the confirmation: what the user needs to read
              // back is not «creada» but «no la has comprado» (#1541).
              await successUrl(
                external ? "investment_transfer_in_added" : "investment_added",
                parsed.command.id,
              );

        // The pricing coordinates of the just-created investment, threaded out so
        // its FIRST quote is asked for in afterCommit (#1314) — the holding would
        // otherwise sit unpriced until the 21:00 capture.
        const firstQuote = {
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
          nowIso: now,
        };

        return { ok: true, value: { redirectUrl, catalog, firstQuote } };
      }

      // Debts — the catalog fixes the type + default debt model so the holding's
      // valuation method is right from creation (loan → amortizable, credit_card →
      // revolving).
      const liabilitySpec = defaults.liability;

      if (liabilitySpec) {
        // A loan lets the user choose its model at creation (#273); mortgage/credit_card
        // keep the fixed model the catalog assigns.
        const debtModel =
          instrument === "loan"
            ? parseLoanDebtModel(actionFormData)
            : liabilitySpec.debtModel;

        // «Alta por estado actual» (ADR 0056, #677): the SIMPLE wizard drawer's
        // debt pane (simpleDrawer==="deuda") offers it as the DEFAULT path for an
        // amortizable mortgage/loan — the CSS reveal (anadir/page.tsx) hides the
        // plain "Saldo pendiente" field for those two and shows the current-state
        // block instead, so `csOutstandingBalance` is the ONLY visible balance
        // input for them regardless of whether the rest of the block (end date,
        // cuota/tipo) is filled — it must always become the liability's balance,
        // never gated on `csEndDate`. Filling the end date on top additionally
        // opts into persisting the plan + re-baseline; leaving it blank keeps a
        // plan-less creation ("origin path" — decide the model later, in the
        // ficha) with the current-state balance intact. Gated on the ORIGINAL
        // `simpleDrawer` (not just the instrument) so the avanzado/canonical form
        // — which has no current-state fields and already posts `balance_*`
        // directly — is untouched.
        const showsCurrentStateBalanceField =
          formData.get("simpleDrawer") === "deuda" &&
          (instrument === "mortgage" ||
            (instrument === "loan" && debtModel === "amortizable"));

        if (showsCurrentStateBalanceField) {
          actionFormData.set(
            `balance_${instrument}`,
            String(actionFormData.get("csOutstandingBalance") ?? ""),
          );
        }

        const scoped = scopedLiabilityForm(
          actionFormData,
          instrument,
          liabilitySpec.type,
        );

        if (!String(scoped.get("name") ?? "").trim()) {
          return { ok: false, error: errorUrl("El nombre de la deuda es obligatorio.") };
        }

        if (parseMoneyMinorField(scoped, "balance") === null) {
          return { ok: false, error: errorUrl("El saldo de la deuda no es válido.") };
        }

        const csEndDate = String(actionFormData.get("csEndDate") ?? "").trim();
        const usesCurrentState = showsCurrentStateBalanceField && csEndDate !== "";
        const currentStateNextPaymentDate = String(
          actionFormData.get("csNextPaymentDate") ?? "",
        ).trim();
        const currentStateInputMode =
          actionFormData.get("csInputMode") === "payment" ? "payment" : "rate";
        const currentStateOriginalSigningDate = String(
          actionFormData.get("csOriginalSigningDate") ?? "",
        ).trim();

        const currentStateDerived = usesCurrentState
          ? deriveCurrentStateDebt({
              annualRatePercent: String(actionFormData.get("csAnnualRate") ?? ""),
              baselineDate: today,
              endDate: csEndDate,
              inputMode: currentStateInputMode,
              monthlyPayment: String(actionFormData.get("csMonthlyPayment") ?? ""),
              nextPaymentDate: currentStateNextPaymentDate,
              originalSigningDate: currentStateOriginalSigningDate,
              outstandingBalance: String(
                actionFormData.get("csOutstandingBalance") ?? "",
              ),
            })
          : null;

        if (currentStateDerived && !currentStateDerived.ok) {
          return { ok: false, error: errorUrl(currentStateDerived.error) };
        }

        const workspace = await store.workspace.readWorkspace();

        if (!workspace) {
          return { ok: false, error: errorUrl("Workspace no inicializado.") };
        }

        const command = parseLiabilityCommand(scoped, workspace.members, Date.now());

        // #171: a liability associated to an asset inherits that asset's ownership
        // split by default — a one-time copy at creation, then independently
        // editable (not a live link, CONTEXT.md). Resolved here, server-side,
        // because the add page carries no client JS (ADR 0009). The pre-checked
        // "mismo reparto" option drives it; unchecked — or no asset associated —
        // falls back to the footer ownership inputs exactly as before.
        const inheritOwnership = scoped.get("inheritOwnership") === "on";
        const associatedAsset = command.associatedAssetId
          ? ((await store.assets.readAssets()).find(
              (a) => a.id === command.associatedAssetId,
            ) ?? null)
          : null;
        // A debt on a co-owned home mirrors the asset's split, which may be a known
        // partial (e.g. 75% mine, 25% a non-member's), so it accepts a partial split
        // exactly like the real_estate asset; a standalone debt still totals 100%.
        const allowKnownPartial = associatedAsset?.type === "real_estate";
        const resolved =
          inheritOwnership && associatedAsset
            ? { ...command, ownership: associatedAsset.ownership }
            : command;

        const domainResult = createLiabilitySafe(workspace, resolved, {
          allowKnownPartial,
        });

        if (!domainResult.ok) {
          return {
            ok: false,
            error: errorUrl(mapDomainViolation(domainResult.violations[0])),
          };
        }

        // ONE unit of work: the deuda, the model that decides how its balance is
        // valued (ADR 0031) and — on the «alta por estado actual» path — its plan and
        // re-baseline commit or roll back together (#1599). Before this seam they were
        // three calls, so a failure after the first left a deuda nobody could draw a
        // curve for.
        await store.command.createDebtHolding({
          debtModel,
          liability: resolved,
          today,
          ...(currentStateDerived?.ok
            ? {
                currentState: buildCurrentStateAmortization(
                  resolved.id,
                  currentStateDerived,
                  {
                    baselineDate: today,
                    endDate: csEndDate,
                    inputMode: currentStateInputMode,
                    nextPaymentDate: currentStateNextPaymentDate,
                    originalSigningDate: currentStateOriginalSigningDate || null,
                  },
                  Date.now(),
                ),
              }
            : {}),
        });

        return {
          ok: true,
          value: { redirectUrl: await successUrl("liability_added", resolved.id) },
        };
      }

      return { ok: false, error: errorUrl("Instrumento no soportado todavía.") };
    },
    // The market holding is written — register its (empty) global-catalog row so
    // it surfaces in /admin/catalogo «por categorizar». Best-effort: never blocks
    // the redirect if the control plane is down (#1097).
    afterCommit: async ({ value }) => {
      if (value?.catalog) {
        await ensureExposureCatalogStubs([value.catalog]);
      }
      if (value?.firstQuote) {
        await fetchFirstQuoteBestEffort(value.firstQuote.asset, value.firstQuote.nowIso);
      }
      // First patrimonio write → stamp the set-once activation mark (#1131).
      await markFirstHoldingBestEffort();
    },
    onError: ({ error }) => error, // run already built the full URL
    onSuccess: ({ value }) => value!.redirectUrl,
  })(formData, ..._testArgs);
}
