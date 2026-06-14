"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import { checkOwnershipSplit, createLiabilitySafe, defaultsFor } from "@worthline/domain";
import type { DebtModel, Instrument, LiabilityType } from "@worthline/domain";
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
} from "../intake";
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

/** The legacy AssetType an asset instrument persists as (its rung comes from the catalog). */
const ASSET_TYPE: Partial<Record<Instrument, "cash" | "manual" | "real_estate">> = {
  current_account: "cash",
  term_deposit: "manual",
  precious_metal: "manual",
  vehicle: "manual",
  other: "manual",
  property: "real_estate",
};

/**
 * How a debt instrument persists: its LiabilityType + the debt model that gives
 * it the right valuation method. The liability's instrument is recoverable from
 * this pair (defaultInstrumentForLiability), so it needs no separate column.
 */
const LIABILITY_SPEC: Partial<
  Record<Instrument, { type: LiabilityType; debtModel: DebtModel }>
> = {
  mortgage: { type: "mortgage", debtModel: "amortizable" },
  loan: { type: "debt", debtModel: "amortizable" },
  credit_card: { type: "debt", debtModel: "revolving" },
};

function parseInstrument(value: FormDataEntryValue | null): Instrument | null {
  const raw = String(value ?? "").trim();
  return (INSTRUMENTS as readonly string[]).includes(raw) ? (raw as Instrument) : null;
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
  carryOwnership(formData, scoped);

  return scoped;
}

export async function createHoldingAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

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

  const defaults = defaultsFor(instrument);

  // Assets — stored (cash/manual) and appreciating (property). Reuse the strict
  // asset parser + shared persistence, stamping the chosen instrument.
  const assetType = ASSET_TYPE[instrument];

  if (assetType) {
    const scoped = scopedAssetForm(formData, instrument, assetType, defaults.rung);
    const result = runWith((store) => {
      const workspace = store.workspace.readWorkspace();

      if (!workspace) {
        return { ok: false as const, error: "Workspace no inicializado." };
      }

      const parsed = parseAssetCommandStrict(scoped, workspace.members, Date.now());

      if (!parsed.ok) {
        return { ok: false as const, error: parsed.error };
      }

      return persistManualAssetCreation(
        store,
        workspace,
        { ...parsed.command, instrument },
        Date.now(),
        new Date().toISOString().slice(0, 10),
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

  // Debts — the instrument fixes the type + debt model so the holding's valuation
  // method is right from creation (loan → amortizable, credit_card → revolving).
  const liabilitySpec = LIABILITY_SPEC[instrument];

  if (liabilitySpec) {
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
      const domainResult = createLiabilitySafe(workspace, command);

      if (!domainResult.ok) {
        return {
          ok: false as const,
          error: mapDomainViolation(domainResult.violations[0]),
        };
      }

      store.liabilities.createLiability(command);
      store.liabilities.setDebtModel(command.id, liabilitySpec.debtModel);

      return { ok: true as const, id: command.id };
    });

    if (!result.ok) {
      redirect(errorUrl(result.error));
    }

    redirect(successRedirectUrl("/patrimonio", "liability_added", result.id));
  }

  redirect(errorUrl("Instrumento no soportado todavía."));
}
