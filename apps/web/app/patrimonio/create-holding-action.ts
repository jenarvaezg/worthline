"use server";

import {
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
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
import { deriveOpeningUnits } from "@web/patrimonio/anadir/investment-units";
import { type WorthlineStore } from "@web/store";
import type { Clock, DebtModel, Instrument, LiabilityType } from "@worthline/domain";
import {
  checkOwnershipSplit,
  createInvestmentOperationSafe,
  createLiabilitySafe,
  defaultsFor,
  systemClock,
} from "@worthline/domain";
import { redirect } from "next/navigation";
import {
  CURRENT_STATE_DEBT_FIELD_NAMES,
  deriveCurrentStateDebt,
} from "./current-state-debt";
import { persistCurrentStateAmortization } from "./persist-current-state-debt";
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

function isClock(value: unknown): value is Clock {
  return (
    typeof value === "object" && value !== null && "now" in value && "today" in value
  );
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

/** The simple investment drawer's two exclusive "how much you have" modes (#597). */
function parseInvMode(value: FormDataEntryValue | null): "saldo" | "import" | null {
  const raw = String(value ?? "").trim();
  return raw === "saldo" || raw === "import" ? raw : null;
}

/** The Spanish guidance for a saldo-de-hoy derivation that lacks a price or a saldo (#597). */
function openingUnitsErrorMessage(reason: "saldo" | "price"): string {
  return reason === "price"
    ? "Necesito el precio por unidad para calcular las participaciones. Búscalo o escríbelo a mano."
    : "Indica cuánto tienes hoy en euros.";
}

/**
 * Record the opening BUY for a freshly-created derived investment from the "saldo
 * de hoy" path (#597): the already-derived units × price, dated today, persisted
 * with its history ripple via the same seam the operations editor uses. Returns a
 * Spanish error message on a domain violation, or null on success.
 */
async function recordOpeningOperation(
  store: WorthlineStore,
  assetId: string,
  opening: { units: string; price: string },
  today: string,
): Promise<string | null> {
  const opForm = new FormData();
  opForm.set("units", opening.units);
  opForm.set("pricePerUnit", opening.price);
  opForm.set("kind", "buy");
  opForm.set("executedAt", today);

  const parsedOp = parseRouteOperationCommand(opForm, assetId, Date.now(), today);

  if (!parsedOp.ok) {
    return parsedOp.error;
  }

  const safe = createInvestmentOperationSafe({ ...parsedOp.command, source: "opening" });

  if (!safe.ok) {
    return mapDomainViolation(safe.violations[0]);
  }

  await store.recordOperationAndRipple(safe.value, { today });
  return null;
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
  "rate",
  "balance",
  "assoc",
  "inheritOwnership",
  "debtModel",
  "isPrimaryResidence",
  // Simple investment drawer capture fields (#597), refilled after a validation error.
  "saldo",
  "invMode",
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
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  const today = _clock.today();
  const returnUrl = parseReturnUrl(formData.get("returnTo"));
  await guardDemoWrite(returnUrl);

  const normalized = normalizeSimpleDrawerForm(formData, today);
  const actionFormData = normalized.formData;
  const instrument = normalized.instrument;

  if (!instrument) {
    redirect(
      errorRedirectUrl(returnUrl, {
        formId: "holding",
        message: normalized.unsupported ?? "Elige un tipo de instrumento.",
        values: preserveFields(
          actionFormData,
          ["instrument", "ownershipPreset", "scopeMemberId", ...SIMPLE_FIELD_KEYS],
          ["owner_"],
        ),
      }),
    );
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
  const successUrl = (okKey: string, id: string): string =>
    returnUrl === ADD_URL
      ? `${successRedirectUrl(ADD_URL, okKey)}&added=${id}`
      : successRedirectUrl("/patrimonio", okKey, id);

  // The catalog owns every per-instrument storage decision: the rung, valuation
  // method and provider, plus the legacy AssetType a stored asset persists as
  // and how a debt persists (its type + default model). The action only reads it.
  const defaults = defaultsFor(instrument);

  // Assets — stored (cash/manual) and appreciating (property). Reuse the strict
  // asset parser + shared persistence, stamping the chosen instrument.
  const assetType = defaults.assetType;

  if (assetType) {
    const scoped = scopedAssetForm(actionFormData, instrument, assetType, defaults.rung);
    const result = await runActionWithStore(async (store) => {
      const workspace = await store.workspace.readWorkspace();

      if (!workspace) {
        return { ok: false as const, error: "Workspace no inicializado." };
      }

      const parsed = parseAssetCommandStrict(
        scoped,
        workspace.members,
        Date.now(),
        today,
      );

      if (!parsed.ok) {
        return { ok: false as const, error: parsed.error };
      }

      return persistManualAssetCreation(
        store,
        workspace,
        { ...parsed.command, instrument },
        Date.now(),
        today,
      );
    }, _store);

    if (!result.ok) {
      redirect(errorUrl(result.error));
    }

    redirect(successUrl("asset_added", result.id));
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

    // (a) "Saldo de hoy": derive units (€ ÷ precio) up-front (pure) so a missing
    // saldo/price fails BEFORE anything is persisted — no orphaned 0 € holding.
    const opening =
      invMode === "saldo"
        ? deriveOpeningUnits({
            priceRaw: String(scoped.get("manualPricePerUnit") ?? ""),
            saldoRaw: String(actionFormData.get(`saldo_${instrument}`) ?? ""),
          })
        : null;

    if (opening && !opening.ok) {
      redirect(errorUrl(openingUnitsErrorMessage(opening.reason)));
    }

    const result = await runActionWithStore(async (store) => {
      const workspace = await store.workspace.readWorkspace();

      if (!workspace) {
        return { ok: false as const, error: "Workspace no inicializado." };
      }

      const parsed = parseInvestmentAssetCommandStrict(
        scoped,
        workspace.members,
        Date.now(),
      );

      if (!parsed.ok) {
        return { ok: false as const, error: parsed.error };
      }

      const splitViolation = checkOwnershipSplit(workspace, parsed.command.ownership);

      if (splitViolation) {
        return { ok: false as const, error: mapDomainViolation(splitViolation) };
      }

      await store.assets.createInvestmentAsset({ ...parsed.command, instrument });

      // Record the opening BUY dated today, so the holding lands valued — not the
      // 0 € container the alta used to create. Never combined with (b) import: a
      // today-dated apertura would not match the CSV's historical orders (merge
      // keys on date) → a duplicate position; the mode exclusion prevents it (#597).
      if (opening?.ok) {
        const opError = await recordOpeningOperation(
          store,
          parsed.command.id,
          opening,
          today,
        );

        if (opError) {
          return { ok: false as const, error: opError };
        }
      }

      return { ok: true as const, id: parsed.command.id };
    }, _store);

    if (!result.ok) {
      redirect(errorUrl(result.error));
    }

    // (b) "Importar extracto": no synthetic opening — route to «Cargar movimientos»
    // (#173) so the broker CSV's historical orders are the only operations.
    if (invMode === "import") {
      redirect(
        successRedirectUrl(`/patrimonio/${result.id}/editar`, "investment_import_ready"),
      );
    }

    redirect(successUrl("investment_added", result.id));
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

    const scoped = scopedLiabilityForm(actionFormData, instrument, liabilitySpec.type);

    if (!String(scoped.get("name") ?? "").trim()) {
      redirect(errorUrl("El nombre de la deuda es obligatorio."));
    }

    if (parseMoneyMinorField(scoped, "balance") === null) {
      redirect(errorUrl("El saldo de la deuda no es válido."));
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
          outstandingBalance: String(actionFormData.get("csOutstandingBalance") ?? ""),
        })
      : null;

    if (currentStateDerived && !currentStateDerived.ok) {
      redirect(errorUrl(currentStateDerived.error));
    }

    const result = await runActionWithStore(async (store) => {
      const workspace = await store.workspace.readWorkspace();

      if (!workspace) {
        return { ok: false as const, error: "Workspace no inicializado." };
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
          ok: false as const,
          error: mapDomainViolation(domainResult.violations[0]),
        };
      }

      await store.liabilities.createLiability(resolved);
      await store.liabilities.setDebtModel(resolved.id, debtModel);

      if (currentStateDerived && currentStateDerived.ok) {
        await persistCurrentStateAmortization(
          store,
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
          today,
        );
      }

      return { ok: true as const, id: resolved.id };
    }, _store);

    if (!result.ok) {
      redirect(errorUrl(result.error));
    }

    redirect(successUrl("liability_added", result.id));
  }

  redirect(errorUrl("Instrumento no soportado todavía."));
}
