"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import {
  checkOwnershipSplit,
  createInvestmentOperationSafe,
  defaultInvestmentPriceProvider,
} from "@worthline/domain";
import type { InvestmentPriceProvider, LiquidityTier } from "@worthline/domain";
import {
  fetchAndCachePrice,
  refreshStalePrices,
  stooqProvider,
  yahooProvider,
  type PriceProvider,
} from "@worthline/pricing";
import { redirect } from "next/navigation";

import type { FormErrorContext } from "../intake";
import {
  errorRedirectUrl,
  mapDomainViolation,
  parseEntityId,
  parseInvestmentAssetCommandStrict,
  parseRouteOperationCommand,
  parseUpdateInvestmentCommand,
  pricesRefreshedRedirectUrl,
  preserveFields,
  successRedirectUrl,
} from "../intake";

// Field lists for error-preserve round-trips
const INVESTMENT_FORM_FIELDS = [
  "name",
  "liquidityTier",
  "unitSymbol",
  "isin",
  "priceProvider",
  "providerSymbol",
  "manualPricePerUnit",
  "ownershipPreset",
];

const OPERATION_FORM_FIELDS = ["kind", "executedAt", "units", "pricePerUnit", "fees"];

const EDIT_INVESTMENT_FIELDS = [
  "name",
  "liquidityTier",
  "unitSymbol",
  "isin",
  "priceProvider",
  "providerSymbol",
  "manualPricePerUnit",
];

// #153 collapsed the /inversiones management routes; investments now live in
// the unified Patrimonio list and on each holding's ficha. These fallbacks only
// fire when a form omits currentUrl (the kept surfaces always set it), so they
// default to the surviving investment homes rather than the removed list.
function currentUrlOf(formData: FormData, fallback = "/patrimonio"): string {
  return (formData.get("currentUrl") as string) || fallback;
}

async function validateInvestmentProviderSymbol(input: {
  assetId: string;
  currency: string;
  liquidityTier: LiquidityTier;
  priceProvider?: InvestmentPriceProvider | undefined;
  providerSymbol?: string | undefined;
}): Promise<string | null> {
  if (!input.providerSymbol) return null;

  const priceProvider =
    input.priceProvider ?? defaultInvestmentPriceProvider(input.liquidityTier);

  // Finect NAVs can lag or disappear temporarily; per issue #106, Finect
  // validation is non-blocking at save time.
  if (priceProvider === "finect") return null;

  const provider = providerForValidation(priceProvider);
  const price = await fetchAndCachePrice(provider, {
    assetId: input.assetId,
    currency: input.currency,
    nowIso: new Date().toISOString(),
    symbol: input.providerSymbol,
  });

  if (price.freshnessState === "fresh") return null;

  return `El símbolo no existe en ${providerLabel(priceProvider)}.`;
}

function providerForValidation(
  provider: Exclude<InvestmentPriceProvider, "finect">,
): PriceProvider {
  switch (provider) {
    case "stooq":
      return stooqProvider;
    case "yahoo":
      return yahooProvider;
  }
}

function providerLabel(provider: InvestmentPriceProvider): string {
  switch (provider) {
    case "stooq":
      return "Stooq";
    case "yahoo":
      return "Yahoo Finance";
    case "finect":
      return "Finect";
  }
}

export async function createInvestmentAction(
  formData: FormData,
  _store?: WorthlineStore,
) {
  const returnUrl = currentUrlOf(formData, "/inversiones/nueva");
  const investmentErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "investment",
      message,
      values: preserveFields(formData, INVESTMENT_FORM_FIELDS, ["owner_"]),
    });

  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  const result = runWith((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return { ok: false as const, error: "Workspace no inicializado." };
    }

    const parsed = parseInvestmentAssetCommandStrict(
      formData,
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

    return { ok: true as const, command: parsed.command, id: parsed.command.id };
  });

  if (!result.ok) {
    redirect(investmentErrorUrl(result.error ?? "No se pudo crear la inversión."));
  }

  const validationError = await validateInvestmentProviderSymbol({
    assetId: result.id,
    currency: result.command.currency,
    liquidityTier: result.command.liquidityTier ?? "market",
    priceProvider: result.command.priceProvider,
    providerSymbol: result.command.providerSymbol,
  });

  if (validationError) {
    redirect(investmentErrorUrl(validationError));
  }

  runWith((store) => store.assets.createInvestmentAsset(result.command));

  redirect(successRedirectUrl(returnUrl, "investment_added", result.id));
}

export async function recordOperationAction(
  routeAssetId: string,
  formData: FormData,
  _store?: WorthlineStore,
) {
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const operationErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "operation",
      message,
      values: preserveFields(formData, OPERATION_FORM_FIELDS),
    });

  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseRouteOperationCommand(formData, routeAssetId, Date.now(), today);

  if (!parsed.ok) {
    redirect(operationErrorUrl(parsed.error));
  }

  const domainResult = createInvestmentOperationSafe(parsed.command);

  if (!domainResult.ok) {
    redirect(operationErrorUrl(mapDomainViolation(domainResult.violations[0])));
  }

  const operationDateKey = domainResult.value.executedAt.slice(0, 10);
  runWith((store) => {
    store.operations.recordOperation(domainResult.value);
    // Backdated operation → reconstruct/ripple historical snapshots (PRD #107).
    store.rippleHistoricalSnapshotsForOperation({
      assetId: domainResult.value.assetId,
      mode: "record",
      operationDateKey,
      today,
    });
  });

  redirect(successRedirectUrl(returnUrl, "saved"));
}

export async function updateInvestmentAction(
  routeAssetId: string,
  formData: FormData,
  _store?: WorthlineStore,
) {
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const editErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "edit",
      message,
      values: preserveFields(formData, EDIT_INVESTMENT_FIELDS),
    });

  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  const parsed = parseUpdateInvestmentCommand(formData, routeAssetId);

  if (!parsed.ok) {
    redirect(editErrorUrl(parsed.error));
  }

  const existing = runWith((store) => store.assets.readInvestmentAssetById(routeAssetId));
  const validationError = await validateInvestmentProviderSymbol({
    assetId: routeAssetId,
    currency: existing?.currency ?? "EUR",
    liquidityTier: parsed.command.liquidityTier ?? existing?.liquidityTier ?? "market",
    priceProvider: parsed.command.priceProvider ?? existing?.priceProvider,
    providerSymbol: parsed.command.providerSymbol,
  });

  if (validationError) {
    redirect(editErrorUrl(validationError));
  }

  runWith((store) => store.assets.updateInvestmentAsset(parsed.command));
  redirect(successRedirectUrl(returnUrl, "saved"));
}

export async function deleteInvestmentAction(
  formData: FormData,
  _store?: WorthlineStore,
) {
  const id = parseEntityId(formData);
  const returnUrl = currentUrlOf(formData, "/patrimonio");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "Identificador de inversión no encontrado.",
      }),
    );
  }

  const changes = runWith((store) =>
    store.assets.softDeleteAsset(id, new Date().toISOString()),
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

export async function restoreInvestmentAction(
  formData: FormData,
  _store?: WorthlineStore,
) {
  const id = parseEntityId(formData);
  const returnUrl = currentUrlOf(formData, "/patrimonio");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "Identificador de inversión no encontrado.",
      }),
    );
  }

  const changes = runWith((store) => store.assets.restoreAsset(id));

  if (changes === 0) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró el elemento — puede que ya no esté en papelera.",
      }),
    );
  }

  redirect(successRedirectUrl(returnUrl, "restored", id));
}

export async function hardDeleteInvestmentAction(
  formData: FormData,
  _store?: WorthlineStore,
) {
  const id = parseEntityId(formData);
  const returnUrl = currentUrlOf(formData, "/patrimonio");
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!id) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "Identificador de inversión no encontrado.",
      }),
    );
  }

  const changes = runWith((store) => store.assets.hardDeleteAsset(id));

  if (changes === 0) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró el elemento en la papelera.",
      }),
    );
  }

  redirect(successRedirectUrl(returnUrl, "hard_deleted"));
}

export async function deleteOperationAction(
  routeAssetId: string,
  formData: FormData,
  _store?: WorthlineStore,
) {
  const operationId = parseEntityId(formData, "operationId");
  const returnUrl = currentUrlOf(formData, `/patrimonio/${routeAssetId}/editar`);
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  if (!operationId) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "Identificador de operación no encontrado.",
      }),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const deleted = runWith((store) => {
    const result = store.operations.deleteOperation(operationId);
    if (result) {
      // Deleting a backdated operation ripples snapshots ≥ its date (PRD #107).
      store.rippleHistoricalSnapshotsForOperation({
        assetId: result.assetId,
        mode: "delete",
        operationDateKey: result.executedAt.slice(0, 10),
        today,
      });
    }
    return result;
  });

  if (!deleted) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la operación — puede que ya se haya eliminado.",
      }),
    );
  }

  redirect(successRedirectUrl(returnUrl, "operation_deleted"));
}

export async function refreshPricesAction(
  formData: FormData,
  _store?: WorthlineStore,
  _provider?: PriceProvider,
) {
  const returnUrl = currentUrlOf(formData, "/patrimonio");
  const nowIso = new Date().toISOString();

  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  const investmentAssets = runWith((store) =>
    store.assets.readInvestmentAssetsWithMeta(),
  );
  const refreshable = investmentAssets.filter((asset) => Boolean(asset.providerSymbol));

  const outcome = await (async () => {
    if (_provider) {
      const provider = _provider;
      const results = await Promise.all(
        refreshable.map(async (asset) => {
          const price = await fetchAndCachePrice(provider, {
            assetId: asset.id,
            symbol: asset.providerSymbol!,
            currency: asset.currency,
            nowIso,
          });
          runWith((store) => store.operations.upsertPrice(price));

          return { price, symbol: asset.providerSymbol! };
        }),
      );

      return {
        failures: results
          .filter((entry) => entry.price.freshnessState === "failed")
          .map((entry) => ({
            symbol: entry.symbol,
            reason: entry.price.staleReason ?? "",
          })),
        updated: results.filter((entry) => entry.price.freshnessState === "fresh").length,
      };
    }

    const forcedStaleCache = refreshable.map((asset) => ({
      assetId: asset.id,
      currency: asset.currency,
      fetchedAt: "1970-01-01T00:00:00.000Z",
      freshnessState: "fresh" as const,
      price: "0",
      source: "stooq" as const,
    }));
    const result = await refreshStalePrices(forcedStaleCache, investmentAssets, nowIso);

    for (const price of result.refreshed) {
      runWith((store) => store.operations.upsertPrice(price));
    }

    return {
      failures: result.failures,
      updated: result.updated,
    };
  })();

  redirect(pricesRefreshedRedirectUrl(returnUrl, outcome));
}

export { type FormErrorContext };
