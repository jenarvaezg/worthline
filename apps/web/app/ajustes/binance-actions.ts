"use server";

import { type WorthlineStore } from "@worthline/db";
import {
  binanceAdapter,
  fetchCoinGeckoHistoryEur,
  fetchCoinGeckoPriceEur,
  getAccountSnapshots,
  getAllBalances,
} from "@worthline/pricing";

import { parseEntityId } from "@web/intake";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  connectSource,
  currentUrlOf,
  disconnectSource,
  syncSource,
} from "./connected-source-lifecycle";

/**
 * Server actions for the Binance connected source (PRD #245, ADR 0021). Since #322
 * (ADR 0027) these are thin wrappers over the GENERIC connect/sync/disconnect
 * lifecycle (`connected-source-lifecycle.ts`), parameterized by the Binance adapter
 * (`binanceAdapter`). Binance-specific signing/parsing/valuation live in the adapter
 * + helpers; this file only wires the real signed network readers into the sync
 * context and the best-effort history backfill into the post-write hook.
 *
 * The API key + secret are SECRETS (ADR 0021): the secret can sign, so never logged,
 * never placed in a redirect URL/query. `withStore` is sync-only, so the sync wiring
 * lists balances + reconstructs history OUTSIDE the store, never awaiting inside a
 * store transaction.
 */

const BINANCE_LABEL = "Binance";

export async function connectBinanceAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  await guardDemoWrite("/ajustes");
  return connectSource(
    binanceAdapter,
    formData,
    {
      formId: "binance",
      missingCredentials: "Pega tu clave de API y tu secreto de Binance (solo lectura).",
      alreadyConnected: "Ya hay una cuenta de Binance conectada.",
      noOwner: "No hay ningún miembro activo que pueda ser propietario de la cuenta.",
      label: BINANCE_LABEL,
      okParam: "binance_connected",
    },
    _store,
  );
}

export async function syncBinanceAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  await guardDemoWrite(currentUrlOf(formData));
  const sourceId = parseEntityId(formData, "sourceId");

  return syncSource(
    binanceAdapter,
    sourceId,
    {
      notFound: "No se encontró la cuenta conectada de Binance.",
      missingCredentials:
        "Las credenciales de Binance no están disponibles. Vuelve a conectar la cuenta.",
      syncFailed:
        "No se pudo sincronizar con Binance. Revisa la clave de API y la conexión.",
      okParam: "binance_synced",
      // Binance signs per request (no token to mint), so there is no cached token.
      parseToken: () => null,
      // Bind the signed all-balances reader (spot + funding + flexible Earn on the
      // market rung + locked Earn on the term-locked rung) + a CoinGecko live price
      // resolver. Awaited OUTSIDE the store write, as the sync ordering demands.
      buildContext: async ({ creds, nowIso, nowMs, persistToken }) => ({
        creds,
        token: null,
        saveToken: persistToken,
        nowIso,
        nowMs,
        listBalances: () => getAllBalances(creds, { nowMs }),
        priceEur: (id) => fetchCoinGeckoPriceEur(id, nowIso),
      }),
      // Post-write (best-effort): a manual sync stamps the `binance` freshness row
      // fresh (PRD #245 S4) so the daily stale-price pass won't immediately re-sync
      // the source it just refreshed, then backfills the reconstructed monthly
      // history into snapshots (PRD #245 S5, #250, ADR 0021). The reconstruction is
      // awaited OUTSIDE the store write; a failure here (snapshot horizon / range
      // outage) must NOT fail the sync — positions are already committed — so it is
      // swallowed.
      afterWrite: async ({ sourceId, nowIso, nowMs, creds, runWith }) => {
        await runWith((store) =>
          store.connectedSources.revaluePositions(sourceId, [], {
            fetchedAt: nowIso,
            freshnessState: "fresh",
          }),
        );

        try {
          const curve = await binanceAdapter.buildHistory!({
            creds,
            token: null,
            nowIso,
            nowMs,
            accountSnapshots: () => getAccountSnapshots(creds, { nowMs }),
            historicalPriceEur: (id, from, to) =>
              fetchCoinGeckoHistoryEur(
                id,
                Date.parse(from),
                Date.parse(`${to}T23:59:59Z`),
                nowIso,
              ),
          });
          await runWith((store) =>
            store.applyBinanceHistoryAndRipple({ sourceId, curve }),
          );
        } catch {
          // History is best-effort; the positions sync already committed.
        }
      },
    },
    currentUrlOf(formData),
    _store,
  );
}

export async function disconnectBinanceAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  await guardDemoWrite(currentUrlOf(formData));
  const sourceId = parseEntityId(formData, "sourceId");
  // The disconnect CHOICE (PRD #245 S6, ADR 0016/0021), mirroring Numista: "freeze"
  // keeps every rung holding as a plain hand-maintained one; anything else (the
  // default) removes the live holdings while frozen snapshots keep the history.
  // Binance spans rungs (#248), so both paths act on ALL rung assets (the store's
  // freeze/remove handle the cross-rung fan-out).
  const freeze = (formData.get("mode") as string) === "freeze";

  return disconnectSource(
    sourceId,
    freeze,
    {
      notFound: "No se encontró la cuenta conectada de Binance.",
      freezeFailed: "No se pudo congelar la cuenta.",
      removeFailed: "No se pudo desconectar la cuenta.",
      frozenParam: "binance_frozen",
      disconnectedParam: "binance_disconnected",
    },
    currentUrlOf(formData),
    _store,
  );
}
