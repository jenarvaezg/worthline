"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import {
  fetchCoinGeckoHistoryEur,
  fetchCoinGeckoPriceEur,
  getAccountSnapshots,
  getAllBalances,
  reconstructBinanceHistory,
  syncBinanceAccount,
} from "@worthline/pricing";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  appendParam,
  errorRedirectUrl,
  parseEntityId,
  parseScopeCookie,
  SCOPE_COOKIE_NAME,
} from "../intake";
import {
  buildBinanceCredentialsJson,
  normalizeBinanceCredentials,
  readBinanceCredentials,
  resolveConnectingOwnership,
} from "./binance-helpers";

/**
 * Server actions for the Binance connected source (PRD #245, ADR 0021).
 *
 * connect: create the derived `crypto` holding on the MARKET rung + the source
 * row, owned 100 % by the connecting member, with the pasted API key + secret
 * stored locally. sync: pull the account's market-rung balances (spot + funding +
 * flexible Earn, signed), resolve each token's live EUR unit price, and replace
 * the source's positions — which
 * re-rolls the holding's value (tokens ripple no history; their value is live).
 * disconnect: drop the holding (the FK cascade removes the source + positions).
 *
 * The API key + secret are SECRETS (the secret can sign): never logged, never
 * placed in a redirect URL/query. `withStore` is sync-only, so the sync action is
 * structured read creds → await the network → write positions, never awaiting
 * inside a store transaction.
 */

const BASE = "/ajustes";
const BINANCE_LABEL = "Binance";

function currentUrlOf(formData: FormData): string {
  return (formData.get("currentUrl") as string) || BASE;
}

function runWith<T>(fn: (store: WorthlineStore) => T, _store?: WorthlineStore): T {
  return _store ? fn(_store) : withStore(fn);
}

/** Resolve the active scope member id from the cookie (the connecting member). */
async function scopeMemberId(): Promise<string | undefined> {
  const jar = await cookies();
  return parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
}

export async function connectBinanceAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const credentials = normalizeBinanceCredentials(
    formData.get("apiKey"),
    formData.get("apiSecret"),
  );
  const returnUrl = currentUrlOf(formData);

  if (!credentials) {
    redirect(
      errorRedirectUrl(returnUrl, {
        formId: "binance",
        message: "Pega tu clave de API y tu secreto de Binance (solo lectura).",
      }),
    );
  }

  const scoped = await scopeMemberId();

  const result = runWith((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return { ok: false as const, error: "Workspace no inicializado." };
    }

    // For now only one Binance source is allowed — a second connect is refused so
    // the settings page shows the existing one as connected instead.
    const existing = store.connectedSources
      .listSources()
      .find((source) => source.adapter === "binance");

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

    store.connectedSources.connect({
      adapter: "binance",
      label: BINANCE_LABEL,
      credentialsJson: buildBinanceCredentialsJson(
        credentials.apiKey,
        credentials.apiSecret,
      ),
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
  const sourceId = parseEntityId(formData, "sourceId");
  const returnUrl = currentUrlOf(formData);

  if (!sourceId) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la cuenta conectada de Binance.",
      }),
    );
  }

  // 1) Read the credentials (sync, inside the store).
  const source = runWith((store) => store.connectedSources.readSource(sourceId), _store);

  if (!source) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la cuenta conectada de Binance.",
      }),
    );
  }

  const credentials = readBinanceCredentials(source.credentialsJson);

  if (!credentials) {
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

  // 2) Network: pull ALL balances — spot + funding + flexible Earn (market) +
  // locked Earn (term-locked) — and value each token live. The source spans rungs
  // now (S3, #248), so the write materializes one holding per occupied rung. On any
  // failure, redirect with a clear message and DO NOT touch existing positions.
  try {
    const drafts = await syncBinanceAccount({
      listBalances: () => getAllBalances(credentials, { nowMs }),
      priceEur: (id) => fetchCoinGeckoPriceEur(id, nowIso),
    });

    // 3) Write: replace positions and re-roll EVERY rung's holding value. Tokens
    // ripple no history (their value is live, never dated), so this is a pure
    // value re-roll across the source's market + term-locked assets. A manual sync
    // also stamps the `binance` freshness row fresh (PRD #245 S4) so the daily
    // stale-price pass won't immediately re-sync the source it just refreshed.
    runWith((store) => {
      store.syncConnectedSource({ positions: drafts, sourceId, syncedAt: nowIso });
      store.connectedSources.revaluePositions(sourceId, [], {
        fetchedAt: nowIso,
        freshnessState: "fresh",
      });
    }, _store);

    // 4) Backfill the reconstructed monthly history into snapshots (PRD #245 S5,
    // #250, ADR 0021). BEST-EFFORT: positions are already synced (step 3), so a
    // failure here (Binance snapshot horizon / CoinGecko range outage) must NOT
    // fail the sync — swallow and fall through to the fresh-stamp + ok redirect.
    // The reconstruction awaits the network OUTSIDE the store write; the backfill
    // is then a sync `applyBinanceHistoryAndRipple` (atomic, append-only/frozen).
    try {
      const curve = await reconstructBinanceHistory({
        accountSnapshots: () => getAccountSnapshots(credentials, { nowMs }),
        historicalPriceEur: (id, from, to) =>
          fetchCoinGeckoHistoryEur(
            id,
            Date.parse(from),
            Date.parse(`${to}T23:59:59Z`),
            nowIso,
          ),
      });
      runWith((store) => {
        store.applyBinanceHistoryAndRipple({ sourceId, curve });
      }, _store);
    } catch {
      // History is best-effort; the positions sync already committed.
    }
  } catch {
    // A bad/expired key or unreachable Binance — surface a clear error. The
    // existing positions are left untouched (we never reached the write).
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
  const sourceId = parseEntityId(formData, "sourceId");
  const returnUrl = currentUrlOf(formData);

  if (!sourceId) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la cuenta conectada de Binance.",
      }),
    );
  }

  const result = runWith((store) => {
    const source = store.connectedSources.readSource(sourceId);

    if (!source) {
      return { ok: false as const, error: "No se encontró la cuenta conectada." };
    }

    // REMOVE path (freeze-into-stored is a later slice): a source materializes one
    // asset per rung now (market + term-locked, #248). `removeSourceHoldings` drops
    // ALL of them in ONE transaction — deleting the market (primary) asset cascades
    // the source row (and its positions) away; the other-rung assets (no back-FK)
    // are removed explicitly — so a mid-loop failure can never leave a
    // partially-deleted source.
    const { removed } = store.connectedSources.removeSourceHoldings(sourceId);

    if (removed === 0) {
      return { ok: false as const, error: "No se pudo desconectar la cuenta." };
    }

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(returnUrl, { message: result.error }));
  }

  redirect(appendParam(returnUrl, "ok", "binance_disconnected"));
}
