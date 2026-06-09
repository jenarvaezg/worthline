"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import { createInvestmentOperationSafe } from "@worthline/domain";
import { fetchAndCachePrice, stooqProvider } from "@worthline/pricing";
import { redirect } from "next/navigation";

import type { FormErrorContext } from "../intake";
import {
  appendParam,
  buildCurrentUrlFor,
  errorRedirectUrl,
  mapDomainViolation,
  parseEntityId,
  parseInvestmentAssetCommandStrict,
  parseOwnership,
  parseRouteOperationCommand,
  parseUpdateInvestmentCommand,
  pricesRefreshedRedirectUrl,
  preserveFields,
  successRedirectUrl,
  validateOwnershipSharesStrict,
} from "../intake";

// Field lists for error-preserve round-trips
const INVESTMENT_FORM_FIELDS = [
  "name",
  "unitSymbol",
  "isin",
  "manualPricePerUnit",
  "ownershipPreset",
];

const OPERATION_FORM_FIELDS = ["kind", "executedAt", "units", "pricePerUnit", "fees"];

const EDIT_INVESTMENT_FIELDS = [
  "name",
  "unitSymbol",
  "isin",
  "manualPricePerUnit",
];

function currentUrlOf(formData: FormData, fallback = "/inversiones"): string {
  return (formData.get("currentUrl") as string) || fallback;
}

export async function createInvestmentAction(formData: FormData) {
  const returnUrl = currentUrlOf(formData, "/inversiones");
  const investmentErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "investment",
      message,
      values: preserveFields(formData, INVESTMENT_FORM_FIELDS, ["owner_"]),
    });

  const result = withStore((store) => {
    const workspace = store.readWorkspace();

    if (!workspace) {
      return { ok: false, error: "Workspace no inicializado." };
    }

    const parsed = parseInvestmentAssetCommandStrict(
      formData,
      workspace.members,
      Date.now(),
    );

    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    const ownershipError = validateOwnershipSharesStrict(parsed.command.ownership);

    if (ownershipError) {
      return { ok: false, error: ownershipError };
    }

    store.createInvestmentAsset(parsed.command);

    return { ok: true, id: parsed.command.id };
  });

  if (!result.ok) {
    redirect(investmentErrorUrl(result.error ?? "No se pudo crear la inversión."));
  }

  redirect(
    successRedirectUrl(returnUrl, "investment_added", result.id),
  );
}

export async function recordOperationAction(
  routeAssetId: string,
  formData: FormData,
  _store?: WorthlineStore,
) {
  const returnUrl = currentUrlOf(
    formData,
    `/inversiones/${routeAssetId}/operacion`,
  );
  const operationErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "operation",
      message,
      values: preserveFields(formData, OPERATION_FORM_FIELDS),
    });

  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseRouteOperationCommand(
    formData,
    routeAssetId,
    Date.now(),
    today,
  );

  if (!parsed.ok) {
    redirect(operationErrorUrl(parsed.error));
  }

  const domainResult = createInvestmentOperationSafe(parsed.command);

  if (!domainResult.ok) {
    redirect(operationErrorUrl(mapDomainViolation(domainResult.violations[0])));
  }

  runWith((store) => store.recordOperation(domainResult.value));

  redirect(successRedirectUrl(returnUrl, "saved"));
}

export async function updateInvestmentAction(
  routeAssetId: string,
  formData: FormData,
) {
  const returnUrl = currentUrlOf(
    formData,
    `/inversiones/${routeAssetId}/editar`,
  );
  const editErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "edit",
      message,
      values: preserveFields(formData, EDIT_INVESTMENT_FIELDS),
    });

  const parsed = parseUpdateInvestmentCommand(formData, routeAssetId);

  if (!parsed.ok) {
    redirect(editErrorUrl(parsed.error));
  }

  withStore((store) => store.updateInvestmentAsset(parsed.command));
  redirect(successRedirectUrl(returnUrl, "saved"));
}

export async function deleteInvestmentAction(formData: FormData) {
  const id = parseEntityId(formData);
  const returnUrl = currentUrlOf(formData, "/inversiones");

  if (!id) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "Identificador de inversión no encontrado.",
      }),
    );
  }

  const changes = withStore((store) =>
    store.softDeleteAsset(id, new Date().toISOString()),
  );

  if (changes === 0) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró el elemento — puede que ya haya sido eliminado.",
      }),
    );
  }

  redirect(successRedirectUrl(returnUrl, "deleted_recoverable", id));
}

export async function restoreInvestmentAction(formData: FormData) {
  const id = parseEntityId(formData);
  const returnUrl = currentUrlOf(formData, "/inversiones");

  if (!id) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "Identificador de inversión no encontrado.",
      }),
    );
  }

  const changes = withStore((store) => store.restoreAsset(id));

  if (changes === 0) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró el elemento — puede que ya no esté en papelera.",
      }),
    );
  }

  redirect(successRedirectUrl(returnUrl, "restored", id));
}

export async function refreshPricesAction(formData: FormData) {
  const returnUrl = currentUrlOf(formData, "/inversiones");
  const nowIso = new Date().toISOString();

  const outcome = await withStore(async (store) => {
    const investmentAssets = store.readInvestmentAssetsWithMeta();
    const refreshable = investmentAssets.filter((asset) =>
      Boolean(asset.providerSymbol),
    );
    const results = await Promise.all(
      refreshable.map(async (asset) => {
        const price = await fetchAndCachePrice(stooqProvider, {
          assetId: asset.id,
          symbol: asset.providerSymbol!,
          currency: asset.currency,
          nowIso,
        });
        store.upsertPrice(price);

        return { price, symbol: asset.providerSymbol! };
      }),
    );

    return {
      failedSymbols: results
        .filter((entry) => entry.price.freshnessState === "failed")
        .map((entry) => entry.symbol),
      updated: results.filter(
        (entry) => entry.price.freshnessState === "fresh",
      ).length,
    };
  });

  redirect(pricesRefreshedRedirectUrl(returnUrl, outcome));
}

export { type FormErrorContext };
