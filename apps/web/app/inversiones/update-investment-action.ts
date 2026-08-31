"use server";

/**
 * The investment's own ficha — name, liquidity rung, unit symbol, ISIN and price
 * configuration (#1606: its own surface, apart from the operations ledger).
 */

import {
  isClock,
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  errorRedirectUrl,
  parseUpdateInvestmentCommand,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import { validateInvestmentProviderSymbol } from "@web/inversiones/provider-symbol-check";
import { currentUrlOf } from "@web/inversiones/return-url";
import {
  defaultInvestmentPriceProvider,
  detectValueOnlyOpening,
  systemClock,
  valueOnlySymbolGuardMessage,
} from "@worthline/domain";
import { redirect } from "next/navigation";

const EDIT_INVESTMENT_FIELDS = [
  "name",
  // #1512: a rejected save must round-trip the instrument the user picked, or the
  // select silently snaps back to the misclassification they came to fix.
  "instrument",
  "liquidityTier",
  "unitSymbol",
  "isin",
  "priceProvider",
  "providerSymbol",
  "manualPricePerUnit",
  // The #1329 acknowledgement: a rejected save must round-trip it, or the user
  // re-ticks the same box on every attempt.
  "valueOnlySymbolAck",
];

export async function updateInvestmentAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData));
  const returnUrl = currentUrlOf(formData);
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

  const existing = await runActionWithStore(
    (store) => store.assets.readInvestmentAssetById(routeAssetId),
    _store,
  );
  const nextLiquidityTier =
    parsed.command.liquidityTier ?? existing?.liquidityTier ?? "market";
  const nextPriceProvider =
    parsed.command.priceProvider ?? defaultInvestmentPriceProvider(nextLiquidityTier);
  const nextProviderSymbol = parsed.command.providerSymbol;
  const priceConfigChanged = Boolean(
    existing &&
      (existing.priceProvider !== nextPriceProvider ||
        existing.providerSymbol !== nextProviderSymbol),
  );
  const symbolCheck = await validateInvestmentProviderSymbol({
    assetId: routeAssetId,
    currency: existing?.currency ?? "EUR",
    liquidityTier: nextLiquidityTier,
    nowIso: _clock.now(),
    priceProvider: nextPriceProvider,
    providerSymbol: parsed.command.providerSymbol,
  });

  if (!symbolCheck.ok) {
    redirect(editErrorUrl(symbolCheck.error));
  }

  // #1329: a holding born «por valor total» is 1 participación × its whole value.
  // Giving it a symbol hands the valuation to the quote, so the position silently
  // becomes worth ONE share — and the fake unit poisons every later buy. Only the
  // save that ADDS a symbol pays the ledger read, and only an explicit «es una
  // participación real» gets through.
  if (nextProviderSymbol && !existing?.providerSymbol) {
    const acknowledged = String(formData.get("valueOnlySymbolAck") ?? "").trim() !== "";
    if (!acknowledged) {
      const operations = await runActionWithStore(
        (store) => store.operations.readOperations(routeAssetId),
        _store,
      );
      const valueOnly = detectValueOnlyOpening(operations);
      if (valueOnly) {
        redirect(
          editErrorUrl(
            valueOnlySymbolGuardMessage({
              opening: valueOnly,
              quotedPricePerUnit: symbolCheck.quotedPricePerUnit,
              symbol: nextProviderSymbol,
            }),
          ),
        );
      }
    }
  }

  await runActionWithStore(async (store) => {
    await store.assets.updateInvestmentAsset(parsed.command);
    if (priceConfigChanged) {
      await store.operations.clearPriceCache(routeAssetId);
    }
  }, _store);
  redirect(successRedirectUrl(returnUrl, "saved"));
}
