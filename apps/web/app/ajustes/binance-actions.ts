"use server";

import { type WorthlineStore } from "@worthline/db";
import {
  fetchCoinGeckoHistoryEur,
  fetchCoinGeckoLogos,
  fetchCoinGeckoPriceEur,
  getAccountSnapshots,
  getAllBalances,
  reconstructBinanceHistory,
  syncBinanceAccount,
} from "@worthline/pricing";
import { redirect } from "next/navigation";

import { runActionWithStore } from "@web/action-store";
import { appendParam, errorRedirectUrl, parseEntityId } from "@web/intake";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  parseBinanceCredentials,
  readBinanceCredentials,
  resolveConnectingOwnership,
  serializeBinanceCredentials,
} from "./binance-helpers";
import { currentUrlOf, scopeMemberId } from "./connected-source-helpers";

/**
 * Server actions for the Binance connected source (PRD #245, ADR 0021). ADR 0043
 * keeps the lifecycle explicit per provider: Binance owns its connect, sync,
 * freshness and history flow here; shared code is limited to leaf helpers.
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
  const returnUrl = currentUrlOf(formData);
  const creds = parseBinanceCredentials(
    formData.get("apiKey"),
    formData.get("apiSecret"),
  );

  if (!creds) {
    redirect(
      errorRedirectUrl(returnUrl, {
        formId: "binance",
        message: "Pega tu clave de API y tu secreto de Binance (solo lectura).",
      }),
    );
  }

  const scoped = await scopeMemberId();
  const result = await runActionWithStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();

    if (!workspace) {
      return { ok: false as const, error: "Workspace no inicializado." };
    }

    const existing = (await store.connectedSources.listSources()).find(
      (source) => source.adapter === "binance",
    );

    if (existing) {
      return { ok: false as const, error: "Ya hay una cuenta de Binance conectada." };
    }

    const ownership = resolveConnectingOwnership(workspace.members, scoped);

    if (!ownership) {
      return {
        ok: false as const,
        error: "No hay ningún miembro activo que pueda ser propietario de la cuenta.",
      };
    }

    await store.connectedSources.connect({
      adapter: "binance",
      label: BINANCE_LABEL,
      credentialsJson: serializeBinanceCredentials(creds),
      ownership,
    });

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(returnUrl, { formId: "binance", message: result.error }));
  }

  redirect(appendParam(returnUrl, "ok", "binance_connected"));
}

export async function syncBinanceAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const returnUrl = currentUrlOf(formData);
  await guardDemoWrite(returnUrl);
  const sourceId = parseEntityId(formData, "sourceId");

  if (!sourceId) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la cuenta conectada de Binance.",
      }),
    );
  }

  const source = await runActionWithStore(
    (store) => store.connectedSources.readSource(sourceId),
    _store,
  );

  if (!source) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la cuenta conectada de Binance.",
      }),
    );
  }

  const creds = readBinanceCredentials(source.credentialsJson);

  if (!creds) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message:
          "Las credenciales de Binance no están disponibles. Vuelve a conectar la cuenta.",
      }),
    );
  }

  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  try {
    const drafts = await syncBinanceAccount({
      listBalances: () => getAllBalances(creds, { nowMs }),
      priceEur: (id) => fetchCoinGeckoPriceEur(id, nowIso),
      logoUrls: fetchCoinGeckoLogos,
    });

    await runActionWithStore(
      (store) =>
        store.syncConnectedSource({ positions: drafts, sourceId, syncedAt: nowIso }),
      _store,
    );

    await runActionWithStore(
      (store) =>
        store.connectedSources.revaluePositions(sourceId, [], {
          fetchedAt: nowIso,
          freshnessState: "fresh",
        }),
      _store,
    );

    try {
      const curve = await reconstructBinanceHistory({
        accountSnapshots: () => getAccountSnapshots(creds, { nowMs }),
        historicalPriceEur: (id, from, to) =>
          fetchCoinGeckoHistoryEur(
            id,
            Date.parse(from),
            Date.parse(`${to}T23:59:59Z`),
            nowIso,
          ),
      });
      await runActionWithStore(
        (store) => store.applyBinanceHistoryAndRipple({ sourceId, curve }),
        _store,
      );
    } catch {
      // History is best-effort; the positions sync already committed.
    }
  } catch {
    redirect(
      errorRedirectUrl(returnUrl, {
        message:
          "No se pudo sincronizar con Binance. Revisa la clave de API y la conexión.",
      }),
    );
  }

  redirect(appendParam(returnUrl, "ok", "binance_synced"));
}

export async function disconnectBinanceAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const returnUrl = currentUrlOf(formData);
  await guardDemoWrite(returnUrl);
  const sourceId = parseEntityId(formData, "sourceId");
  const freeze = (formData.get("mode") as string) === "freeze";

  if (!sourceId) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la cuenta conectada de Binance.",
      }),
    );
  }

  const result = await runActionWithStore(async (store) => {
    const source = await store.connectedSources.readSource(sourceId);

    if (!source) {
      return {
        ok: false as const,
        error: "No se encontró la cuenta conectada de Binance.",
      };
    }

    if (freeze) {
      const frozen = await store.connectedSources.freezeIntoStoredHolding(sourceId);
      return frozen
        ? { ok: true as const, message: "binance_frozen" }
        : { ok: false as const, error: "No se pudo congelar la cuenta." };
    }

    const { removed } = await store.connectedSources.removeSourceHoldings(sourceId);
    return removed > 0
      ? { ok: true as const, message: "binance_disconnected" }
      : { ok: false as const, error: "No se pudo desconectar la cuenta." };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(returnUrl, { message: result.error }));
  }

  redirect(appendParam(returnUrl, "ok", result.message));
}
