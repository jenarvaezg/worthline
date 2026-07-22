"use server";

import { runActionWithStore, testStoreFromActionArgs } from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import { ingestionBlockedMessage } from "@web/entitlements/ingestion-guard";
import {
  PAYWALL_CONNECT_SOURCE_MESSAGE,
  PAYWALL_SOURCES_PAUSED_MESSAGE,
} from "@web/entitlements/paywall-copy";
import { formAction } from "@web/form-action";
import { appendParam, errorRedirectUrl, parseEntityId } from "@web/intake";
import type { CoinPosition } from "@worthline/domain";
import {
  fetchMetalSpotEur,
  getCollectedItems,
  getPrices,
  getTypeDetail,
  isTokenValid,
  type MetalKind,
  mintNumistaToken,
  syncNumistaCollection,
} from "@worthline/pricing";
import { redirect } from "next/navigation";
import {
  CONNECTED_SOURCE_PERSISTENCE_ERROR_MESSAGE,
  connectedSourceProviderErrorMessage,
  currentUrlOf,
  scopeMemberId,
} from "./connected-source-helpers";
import { enforceConnectedSourceSyncThrottle } from "./connected-source-sync-throttle-guard";
import { runNumistaCoinRefresh } from "./numista-coin-refresh";
import {
  normalizeApiKey,
  parseNumistaToken,
  readApiKey,
  resolveConnectingOwnership,
} from "./numista-helpers";
import { enqueueSourceSync } from "./source-sync-enqueue";

/**
 * Server actions for the Numista connected source (PRD #160 / #163, ADR 0016/0017).
 * ADR 0043 keeps the lifecycle explicit per provider: Numista owns its connect,
 * sync and disconnect flow here; shared code is limited to leaf helpers.
 *
 * The API key is a SECRET: never logged, never placed in a redirect URL/query.
 * `withStore` is sync-only, so the sync wiring mints/refreshes the token and lists
 * the collection OUTSIDE the store, never awaiting inside a store transaction.
 */

const NUMISTA_LABEL = "Colección Numista";

export const connectNumistaAction = formAction({
  requireId: false,
  datedFact: false,
  guardUrl: () => "/ajustes",
  parse: ({ formData }) => {
    const apiKey = normalizeApiKey(formData.get("apiKey"));
    if (!apiKey) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          formId: "numista",
          message: "Pega tu clave de API de Numista para conectar la colección.",
        }),
      };
    }
    return { ok: true, value: apiKey };
  },
  run: async (store, { parsed }) => {
    // Connecting a data source is premium ingestion (#1162): manual tracking
    // stays free, but the machine only syncs a source for premium.
    const paywall = await ingestionBlockedMessage(PAYWALL_CONNECT_SOURCE_MESSAGE);
    if (paywall) {
      return { ok: false, error: paywall };
    }

    const scoped = await scopeMemberId();
    const workspace = await store.workspace.readWorkspace();

    if (!workspace) {
      return { ok: false, error: "Workspace no inicializado." };
    }

    const existing = (await store.connectedSources.listSources()).find(
      (source) => source.adapter === "numista",
    );

    if (existing) {
      return { ok: false, error: "Ya hay una colección Numista conectada." };
    }

    const ownership = resolveConnectingOwnership(workspace.members, scoped);

    if (!ownership) {
      return {
        ok: false,
        error: "No hay ningún miembro activo que pueda ser propietario de la colección.",
      };
    }

    await store.connectedSources.connect({
      adapter: "numista",
      label: NUMISTA_LABEL,
      credentialsJson: JSON.stringify({ apiKey: parsed }),
      ownership,
    });

    // Eager sync on connect (#895, #785 dim.2): the GET is now cache-only and no
    // longer syncs, so without this the collection would show 0 positions until
    // the next cron. Reuses the cron/GET orchestration (stale-gated → a just-
    // connected source with no freshness always syncs). Best-effort: a Numista
    // outage degrades to last-known inside the refresh and never fails connect.
    //
    // NOT enqueued onto the durable queue (unlike Binance connect, PRD #999 S4):
    // `runNumistaCoinRefresh` is a metal-spot REVALUATION that persists via
    // `revaluePositions`, not `syncConnectedSource` — it never opens a `sync_run`,
    // so there is no `source-sync` job to enqueue here. The manual Numista refresh
    // (which does go through `syncConnectedSource`) is the one that enqueues.
    try {
      await runNumistaCoinRefresh(store, new Date().toISOString());
    } catch {
      // Connecting still succeeds; the twice-daily cron will retry the sync.
    }

    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { formId: "numista", message: error }),
  onSuccess: ({ formData }) =>
    appendParam(currentUrlOf(formData), "ok", "numista_connected"),
});

export async function syncNumistaAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  const returnUrl = currentUrlOf(formData);
  await guardDemoWrite(returnUrl);

  // A lapsed-to-free workspace keeps its imported data but its sources are
  // paused (#1162): a manual sync is refused with the same honest notice.
  const paywall = await ingestionBlockedMessage(PAYWALL_SOURCES_PAUSED_MESSAGE);
  if (paywall) {
    redirect(errorRedirectUrl(returnUrl, { message: paywall }));
  }

  const sourceId = parseEntityId(formData, "sourceId");

  if (!sourceId) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la fuente conectada de Numista.",
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
        message: "No se encontró la fuente conectada de Numista.",
      }),
    );
  }

  const apiKey = readApiKey(source.credentialsJson);

  if (!apiKey) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message:
          "La clave de API de Numista no está disponible. Vuelve a conectar la colección.",
      }),
    );
  }

  const creds = { apiKey };
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  await enforceConnectedSourceSyncThrottle(returnUrl);

  let token = parseNumistaToken(source.tokenJson);

  if (!token || !isTokenValid(token, nowMs)) {
    try {
      token = await mintNumistaToken(creds, nowMs);
    } catch {
      redirect(
        errorRedirectUrl(returnUrl, {
          message: connectedSourceProviderErrorMessage("Numista"),
        }),
      );
    }

    try {
      await runActionWithStore(
        (store) => store.connectedSources.saveToken(sourceId, JSON.stringify(token)),
        _store,
      );
    } catch {
      redirect(
        errorRedirectUrl(returnUrl, {
          message: CONNECTED_SOURCE_PERSISTENCE_ERROR_MESSAGE,
        }),
      );
    }
  }

  let existingCoins;
  try {
    existingCoins = (
      await runActionWithStore(
        (store) => store.connectedSources.readPositions(sourceId),
        _store,
      )
    )
      .filter((position): position is CoinPosition => position.kind === "coin")
      .map((coin) => ({
        externalId: coin.externalId,
        catalogueId: coin.catalogueId,
        issueId: coin.issueId,
        grade: coin.grade,
        quantity: coin.quantity,
        metal: coin.metal as MetalKind | null,
        finenessMillis: coin.finenessMillis,
        weightGrams: coin.weightGrams,
        obverseThumbUrl: coin.obverseThumbUrl,
        numismaticValueMinor: coin.numismaticValueMinor,
        numismaticFetchedAt: coin.numismaticFetchedAt,
      }));
  } catch {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: CONNECTED_SOURCE_PERSISTENCE_ERROR_MESSAGE,
      }),
    );
  }

  let drafts;
  try {
    if (!token || !isTokenValid(token, nowMs)) {
      redirect(
        errorRedirectUrl(returnUrl, {
          message: connectedSourceProviderErrorMessage("Numista"),
        }),
      );
    }
    const bound = token;

    drafts = await syncNumistaCollection(
      {
        listItems: () => getCollectedItems(creds, bound.accessToken, bound.userId),
        typeDetail: (typeId) => getTypeDetail(creds, typeId),
        prices: (typeId, issueId) =>
          getPrices(creds, typeId, issueId)
            .then((prices) => prices)
            .catch(() => null),
        spotPerOzEur: (metal) => fetchMetalSpotEur(metal, nowIso),
      },
      nowIso,
      existingCoins,
    );
  } catch {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: connectedSourceProviderErrorMessage("Numista"),
      }),
    );
  }

  try {
    // Enqueue the persist onto the durable queue (PRD #999 S4, #1064) instead of
    // running it inline — drained in-process locally, off a worker hosted. The
    // throttle above already gated this call, so enqueuing never bypasses it.
    const payload = {
      positions: drafts,
      sourceId,
      syncedAt: nowIso,
      trigger: "manual" as const,
    };
    await enqueueSourceSync(payload, () =>
      runActionWithStore((store) => store.command.syncConnectedSource(payload), _store),
    );
  } catch {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: CONNECTED_SOURCE_PERSISTENCE_ERROR_MESSAGE,
      }),
    );
  }

  redirect(appendParam(returnUrl, "ok", "numista_synced"));
}

export const disconnectNumistaAction = formAction({
  requireId: false,
  datedFact: false,
  extraIds: ["sourceId"],
  guardUrl: (fd) => currentUrlOf(fd),
  missingId: "No se encontró la fuente conectada de Numista.",
  missingIdUrl: (fd) => currentUrlOf(fd),
  run: async (store, { extra, formData }) => {
    const freeze = (formData.get("mode") as string) === "freeze";
    const source = await store.connectedSources.readSource(extra.sourceId!);

    if (!source) {
      return { ok: false, error: "No se encontró la fuente conectada de Numista." };
    }

    if (freeze) {
      const frozen = await store.connectedSources.freezeIntoStoredHolding(
        extra.sourceId!,
      );
      return frozen
        ? { ok: true, value: { message: "numista_frozen" } }
        : { ok: false, error: "No se pudo congelar la colección." };
    }

    const { removed } = await store.connectedSources.removeSourceHoldings(
      extra.sourceId!,
    );
    return removed > 0
      ? { ok: true, value: { message: "numista_disconnected" } }
      : { ok: false, error: "No se pudo desconectar la colección." };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  onSuccess: ({ formData, value }) =>
    appendParam(currentUrlOf(formData), "ok", value!.message),
});
