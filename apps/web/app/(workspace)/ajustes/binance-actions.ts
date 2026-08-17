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
import {
  type BinanceCredentials,
  fetchCoinGeckoHistoryEur,
  fetchCoinGeckoLogos,
  fetchCoinGeckoPriceEur,
  getAccountSnapshots,
  getAllBalances,
  getSpotBalances,
  reconstructBinanceHistory,
  syncBinanceAccount,
} from "@worthline/pricing";
import { redirect } from "next/navigation";
import {
  parseBinanceCredentials,
  readBinanceCredentials,
  resolveConnectingOwnership,
  serializeBinanceCredentials,
} from "./binance-helpers";
import { runBinanceRefresh } from "./binance-refresh";
import {
  BINANCE_CONNECT_FORM_ID,
  BINANCE_CREDENTIALS_FORM_ID,
} from "./connected-source-form-ids";
import {
  CONNECTED_SOURCE_PERSISTENCE_ERROR_MESSAGE,
  connectedSourceCredentialsRejectedMessage,
  connectedSourceProviderErrorMessage,
  currentUrlOf,
  scopeMemberId,
} from "./connected-source-helpers";
import { enforceConnectedSourceSyncThrottle } from "./connected-source-sync-throttle-guard";
import { enqueueSourceSync } from "./source-sync-enqueue";

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

export const connectBinanceAction = formAction({
  requireId: false,
  datedFact: false,
  // El formulario vive en /ajustes/conexiones (#1223), así que el guard de demo
  // devuelve a la página desde la que se envió, no a la raíz de ajustes.
  guardUrl: (formData) => currentUrlOf(formData),
  parse: ({ formData }) => {
    const creds = parseBinanceCredentials(
      formData.get("apiKey"),
      formData.get("apiSecret"),
    );
    if (!creds) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          formId: BINANCE_CONNECT_FORM_ID,
          message: "Pega tu clave de API y tu secreto de Binance (solo lectura).",
        }),
      };
    }
    return { ok: true, value: creds };
  },
  run: async (store, { parsed }) => {
    // Connecting a data source is premium ingestion (#1162): a free workspace
    // keeps everything it typed, but the machine only syncs for premium.
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
      (source) => source.adapter === "binance",
    );

    if (existing) {
      return { ok: false, error: "Ya hay una cuenta de Binance conectada." };
    }

    const ownership = resolveConnectingOwnership(workspace.members, scoped);

    if (!ownership) {
      return {
        ok: false,
        error: "No hay ningún miembro activo que pueda ser propietario de la cuenta.",
      };
    }

    await store.connectedSources.connect({
      adapter: "binance",
      label: BINANCE_LABEL,
      credentialsJson: serializeBinanceCredentials(parsed),
      ownership,
    });

    // Eager sync on connect (#895, #785 dim.2): the GET is now cache-only and no
    // longer syncs, so without this the source would show 0 positions until the
    // next cron. Reuses the cron/GET orchestration (stale-gated → a just-
    // connected source with no freshness always syncs). The persist ENQUEUES onto
    // the durable queue (PRD #999 S4, #1064) — drained in-process locally, off a
    // worker hosted. Best-effort: a Binance outage degrades to last-known inside
    // the refresh and never fails connect.
    try {
      await runBinanceRefresh(store, new Date().toISOString(), "connect", (params) =>
        enqueueSourceSync(params, () => store.command.syncConnectedSource(params)),
      );
    } catch {
      // Connecting still succeeds; the twice-daily cron will retry the sync.
    }

    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), {
      formId: BINANCE_CONNECT_FORM_ID,
      message: error,
    }),
  onSuccess: ({ formData }) =>
    appendParam(currentUrlOf(formData), "ok", "binance_connected"),
});

/**
 * Cambiar la clave + secreto de una cuenta YA conectada (#1225, PRD #1222).
 *
 * Rotar credenciales de Binance es lo corriente —la buena práctica es una clave de
 * solo lectura con caducidad—, y hasta ahora exigía desconectar y reconectar:
 * pasar por el fork remove/freeze y perder (o congelar) posiciones e histórico que
 * nunca dejaron de ser válidos. Esta acción cambia solo el secreto.
 *
 * El orden NO es negociable: **primero se valida contra Binance, y solo si acepta
 * se escribe**. La sonda es un `GET /api/v3/account` firmado — la llamada más
 * barata que ejercita las DOS mitades del secreto (la clave viaja en la cabecera,
 * el secreto firma la query), así que una clave buena con un secreto mal pegado
 * también se rechaza. Escribir antes de preguntar dejaría la conexión muerta y sin
 * las credenciales anteriores para volver atrás.
 */
export const recredentialBinanceAction = formAction<BinanceCredentials>({
  requireId: false,
  datedFact: false,
  extraIds: ["sourceId"],
  guardUrl: (formData) => currentUrlOf(formData),
  missingId: "No se encontró la cuenta conectada de Binance.",
  missingIdUrl: (formData) => currentUrlOf(formData),
  parse: ({ formData }) => {
    const creds = parseBinanceCredentials(
      formData.get("apiKey"),
      formData.get("apiSecret"),
    );
    if (!creds) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          formId: BINANCE_CREDENTIALS_FORM_ID,
          message:
            "Pega la clave de API y el secreto nuevos de Binance (solo lectura) para cambiarlos.",
        }),
      };
    }
    return { ok: true, value: creds };
  },
  run: async (store, { extra, now, parsed }) => {
    // Una fuente viva es ingesta premium (#1162): un workspace lapsado conserva lo
    // importado, pero la máquina no vuelve a hablar con el proveedor por él — y
    // esta acción hace exactamente eso (valida y sincroniza).
    const paywall = await ingestionBlockedMessage(PAYWALL_SOURCES_PAUSED_MESSAGE);
    if (paywall) {
      return { ok: false, error: paywall };
    }

    const sourceId = extra.sourceId!;
    const source = await store.connectedSources.readSource(sourceId);

    // El adapter se comprueba, no se asume: `sourceId` llega del formulario, y
    // escribir un par clave+secreto sobre una fuente de Numista la dejaría con una
    // credencial que su cliente no sabe leer. Es una línea contra un fallo silencioso.
    if (!source || source.adapter !== "binance") {
      return { ok: false, error: "No se encontró la cuenta conectada de Binance." };
    }

    try {
      await getSpotBalances(parsed, { nowMs: Date.parse(now) });
    } catch {
      return { ok: false, error: connectedSourceCredentialsRejectedMessage("Binance") };
    }

    await store.connectedSources.updateCredentials(
      sourceId,
      serializeBinanceCredentials(parsed),
    );

    // Sync eager, igual que en connect (#895): la clave nueva puede ver otras
    // carteras, y el GET ya no sincroniza. Sigue siendo stale-gated, que aquí es lo
    // correcto: el caso normal de una rotación es una fuente que llevaba días
    // fallando (y por tanto marcada rancia), mientras que rotar una clave que aún
    // funcionaba no cambia ni un saldo. Best-effort — una caída de Binance no
    // deshace el cambio de credenciales, que es lo que el usuario vino a hacer.
    try {
      await runBinanceRefresh(store, now, "manual", (params) =>
        enqueueSourceSync(params, () => store.command.syncConnectedSource(params)),
      );
    } catch {
      // El cron reintentará; las credenciales ya están guardadas.
    }

    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), {
      formId: BINANCE_CREDENTIALS_FORM_ID,
      message: error,
    }),
  onSuccess: ({ formData }) =>
    appendParam(currentUrlOf(formData), "ok", "binance_credentials_updated"),
});

export async function syncBinanceAction(
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

  await enforceConnectedSourceSyncThrottle(returnUrl);

  let drafts;
  try {
    drafts = await syncBinanceAccount({
      listBalances: () => getAllBalances(creds, { nowMs }),
      priceEur: (id) => fetchCoinGeckoPriceEur(id, nowIso),
      logoUrls: fetchCoinGeckoLogos,
    });
  } catch {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: connectedSourceProviderErrorMessage("Binance"),
      }),
    );
  }

  try {
    // Enqueue the persist onto the durable queue (PRD #999 S4, #1064) instead of
    // running it inline — drained in-process locally, off a worker hosted. The
    // throttle above already gated this call, so enqueuing never bypasses it. The
    // observable `sync_run` + derived `last_sync_at` update when the job completes.
    const payload = {
      positions: drafts,
      sourceId,
      syncedAt: nowIso,
      trigger: "manual" as const,
    };
    await enqueueSourceSync(payload, () =>
      runActionWithStore((store) => store.command.syncConnectedSource(payload), _store),
    );

    await runActionWithStore(
      (store) =>
        store.connectedSources.revaluePositions(sourceId, [], {
          fetchedAt: nowIso,
          freshnessState: "fresh",
        }),
      _store,
    );
  } catch {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: CONNECTED_SOURCE_PERSISTENCE_ERROR_MESSAGE,
      }),
    );
  }

  try {
    const curve = await reconstructBinanceHistory({
      accountSnapshots: () => getAccountSnapshots(creds, { nowMs }),
      historicalPriceEur: (id, from, to) =>
        fetchCoinGeckoHistoryEur(
          id,
          Date.parse(from),
          Date.parse(`${to}T23:59:59Z`),
          nowIso,
        ).then((r) => r.pricesByDate),
    });
    await runActionWithStore(
      (store) => store.command.applyBinanceHistory({ sourceId, curve }),
      _store,
    );
  } catch {
    // History is best-effort; the positions sync already committed.
  }

  redirect(appendParam(returnUrl, "ok", "binance_synced"));
}

export const disconnectBinanceAction = formAction({
  requireId: false,
  datedFact: false,
  extraIds: ["sourceId"],
  guardUrl: (fd) => currentUrlOf(fd),
  missingId: "No se encontró la cuenta conectada de Binance.",
  missingIdUrl: (fd) => currentUrlOf(fd),
  run: async (store, { extra, formData }) => {
    const freeze = (formData.get("mode") as string) === "freeze";
    const source = await store.connectedSources.readSource(extra.sourceId!);

    if (!source) {
      return { ok: false, error: "No se encontró la cuenta conectada de Binance." };
    }

    if (freeze) {
      const frozen = await store.connectedSources.freezeIntoStoredHolding(
        extra.sourceId!,
      );
      return frozen
        ? { ok: true, value: { message: "binance_frozen" } }
        : { ok: false, error: "No se pudo congelar la cuenta." };
    }

    const { removed } = await store.connectedSources.removeSourceHoldings(
      extra.sourceId!,
    );
    return removed > 0
      ? { ok: true, value: { message: "binance_disconnected" } }
      : { ok: false, error: "No se pudo desconectar la cuenta." };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  onSuccess: ({ formData, value }) =>
    appendParam(currentUrlOf(formData), "ok", value!.message),
});
