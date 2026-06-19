"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import {
  checkOwnershipSplit,
  createLiabilitySafe,
  defaultsFor,
  systemClock,
} from "@worthline/domain";
import type { Clock, DebtModel, Instrument, LiabilityType } from "@worthline/domain";
import { redirect } from "next/navigation";

import {
  errorRedirectUrl,
  mapDomainViolation,
  parseAssetCommandStrict,
  parseInvestmentAssetCommandStrict,
  parseLiabilityCommand,
  parseMoneyMinorField,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
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

/** The suffixed field keys an instrument may post — preserved on a validation error. */
const FIELD_KEYS = [
  "name",
  "value",
  "symbol",
  "price",
  "acqDate",
  "acqValue",
  "rate",
  "balance",
  "assoc",
  "inheritOwnership",
  "debtModel",
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
  _store?: WorthlineStore,
  _clock: Clock = systemClock(),
): Promise<never> {
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  const today = _clock.today();
  const instrument = parseInstrument(formData.get("instrument"));

  if (!instrument) {
    redirect(errorRedirectUrl(ADD_URL, { message: "Elige un tipo de instrumento." }));
  }

  // On error, reopen the chosen instrument's pane and refill what was typed.
  const errorUrl = (message: string): string =>
    errorRedirectUrl(ADD_URL, {
      formId: "holding",
      message,
      values: preserveFields(
        formData,
        [
          "instrument",
          "ownershipPreset",
          "scopeMemberId",
          ...FIELD_KEYS.map((k) => `${k}_${instrument}`),
        ],
        ["owner_"],
      ),
    });

  // The catalog owns every per-instrument storage decision: the rung, valuation
  // method and provider, plus the legacy AssetType a stored asset persists as
  // and how a debt persists (its type + default model). The action only reads it.
  const defaults = defaultsFor(instrument);

  // Assets — stored (cash/manual) and appreciating (property). Reuse the strict
  // asset parser + shared persistence, stamping the chosen instrument.
  const assetType = defaults.assetType;

  if (assetType) {
    const scoped = scopedAssetForm(formData, instrument, assetType, defaults.rung);
    const result = runWith((store) => {
      const workspace = store.workspace.readWorkspace();

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
    });

    if (!result.ok) {
      redirect(errorUrl(result.error));
    }

    redirect(successRedirectUrl("/patrimonio", "asset_added", result.id));
  }

  // Derived investments — value is units × price; the provider comes from the
  // instrument (yahoo / finect / coingecko), not a form dropdown.
  if (defaults.valuationMethod === "derived") {
    const scoped = scopedInvestmentForm(
      formData,
      instrument,
      defaults.priceProvider,
      defaults.rung,
    );
    const result = runWith((store) => {
      const workspace = store.workspace.readWorkspace();

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

      store.assets.createInvestmentAsset({ ...parsed.command, instrument });

      return { ok: true as const, id: parsed.command.id };
    });

    if (!result.ok) {
      redirect(errorUrl(result.error));
    }

    redirect(successRedirectUrl("/patrimonio", "investment_added", result.id));
  }

  // Debts — the catalog fixes the type + default debt model so the holding's
  // valuation method is right from creation (loan → amortizable, credit_card →
  // revolving).
  const liabilitySpec = defaults.liability;

  if (liabilitySpec) {
    // A loan lets the user choose its model at creation (#273); mortgage/credit_card
    // keep the fixed model the catalog assigns.
    const debtModel =
      instrument === "loan" ? parseLoanDebtModel(formData) : liabilitySpec.debtModel;
    const scoped = scopedLiabilityForm(formData, instrument, liabilitySpec.type);

    if (!String(scoped.get("name") ?? "").trim()) {
      redirect(errorUrl("El nombre de la deuda es obligatorio."));
    }

    if (parseMoneyMinorField(scoped, "balance") === null) {
      redirect(errorUrl("El saldo de la deuda no es válido."));
    }

    const result = runWith((store) => {
      const workspace = store.workspace.readWorkspace();

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
        ? (store.assets.readAssets().find((a) => a.id === command.associatedAssetId) ??
          null)
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

      store.liabilities.createLiability(resolved);
      store.liabilities.setDebtModel(resolved.id, debtModel);

      return { ok: true as const, id: resolved.id };
    });

    if (!result.ok) {
      redirect(errorUrl(result.error));
    }

    redirect(successRedirectUrl("/patrimonio", "liability_added", result.id));
  }

  redirect(errorUrl("Instrumento no soportado todavía."));
}
