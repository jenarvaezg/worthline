"use server";

/**
 * The investment's own ficha — name, liquidity rung, unit symbol, identifier and
 * price configuration (#1606: its own surface, apart from the operations ledger).
 *
 * Since #1746 the identifier field is the instrument's own (ISIN, or a plan's DGS
 * code) and it is validated as such: an interactive write never stores a value
 * under a kind it does not belong to (invariante 3 del PRD #1741). The same submit
 * also carries the plan's retry — «búscame el símbolo por el código DGS» — so a
 * plan born «identificado, sin cotizar» because Finect was down has one gesture
 * that finishes the job, and it goes through every guard the manual symbol does.
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
  securityIdToWriteFromFicha,
  successRedirectUrl,
} from "@web/intake";
import { resolvePlanSymbolFromDgs } from "@web/inversiones/plan-symbol-seed";
import { validateInvestmentProviderSymbol } from "@web/inversiones/provider-symbol-check";
import { currentUrlOf } from "@web/inversiones/return-url";
import type { UpdateInvestmentAssetInput } from "@worthline/db";
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
  "securityId",
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

  // El reintento del plan (#1746): el botón «Buscar el símbolo…» es el MISMO envío
  // de la ficha con una marca, así que lo que se siembra pasa por la comprobación
  // del símbolo y por la guarda de #1329 igual que si lo hubiera teclado el usuario.
  // Sin código no hay nada que resolver, y un Finect callado se dice — no se guarda
  // a medias: «identificado, sin cotizar» sigue siendo el estado, y se puede
  // reintentar más tarde.
  // El identificador que este formulario NO pudo enseñar no se toca (ver
  // `securityIdToWriteFromFicha`): un instrumento sin identificador no tiene campo,
  // y un valor guardado de otra clase —o sin clase ninguna, #1770— se enseña en una
  // línea, no en la caja. Guardar sin teclear no contesta por ninguno de los dos.
  const securityId = securityIdToWriteFromFicha({
    formData,
    stored: existing?.securityId,
    submitted: parsed.command.securityId,
  });
  const command = await seedPlanSymbolIfAsked(
    securityId ? { ...parsed.command, securityId } : parsed.command,
    formData,
    editErrorUrl,
  );

  const nextLiquidityTier = command.liquidityTier ?? existing?.liquidityTier ?? "market";
  const nextPriceProvider =
    command.priceProvider ?? defaultInvestmentPriceProvider(nextLiquidityTier);
  const nextProviderSymbol = command.providerSymbol;
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
    providerSymbol: nextProviderSymbol,
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
    await store.assets.updateInvestmentAsset(command);
    if (priceConfigChanged) {
      await store.operations.clearPriceCache(routeAssetId);
    }
  }, _store);
  redirect(successRedirectUrl(returnUrl, "saved"));
}

/**
 * The plan's «Buscar el símbolo en Finect por su código DGS» retry, resolved into
 * the command the ordinary save is about to write.
 *
 * It refuses out loud rather than saving half of it: without a DGS code there is
 * nothing to resolve, and a Finect that does not answer leaves the holding exactly
 * as it was — identified, not quoting, retryable. The symbol it seeds is not
 * trusted either: it travels on through `validateInvestmentProviderSymbol` and the
 * #1329 value-only guard like any hand-typed one.
 */
async function seedPlanSymbolIfAsked(
  command: UpdateInvestmentAssetInput,
  formData: FormData,
  editErrorUrl: (message: string) => string,
): Promise<UpdateInvestmentAssetInput> {
  if (String(formData.get("seedPlanSymbol") ?? "").trim() === "") {
    return command;
  }

  if (command.securityId?.kind !== "dgs") {
    redirect(
      editErrorUrl(
        "Para buscar el símbolo hace falta el código DGS del plan (N seguida de cuatro cifras). Escríbelo y vuelve a intentarlo.",
      ),
    );
  }

  const code = command.securityId.value;
  const symbol = await resolvePlanSymbolFromDgs(code);

  if (!symbol) {
    redirect(
      editErrorUrl(
        `Finect no ha reconocido ${code} ahora mismo. Revisa el código de tu extracto o vuelve a intentarlo más tarde: el plan sigue identificado por su código, solo sin cotizar.`,
      ),
    );
  }

  return { ...command, priceProvider: "finect", providerSymbol: symbol };
}
