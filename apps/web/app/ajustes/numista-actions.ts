"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import {
  fetchMetalSpotEur,
  getCollectedItems,
  getPrices,
  getTypeDetail,
  isTokenValid,
  mintNumistaToken,
  syncNumistaCollection,
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
  buildCredentialsJson,
  normalizeApiKey,
  parseNumistaToken,
  readApiKey,
  resolveConnectingOwnership,
} from "./numista-helpers";

/**
 * Server actions for the Numista connected source (PRD #160 / #163, ADR 0016/0017).
 *
 * connect: create the derived coin_collection holding at €0 + the source row,
 * owned 100 % by the connecting member, with the pasted API key stored locally.
 * sync: mint/refresh the OAuth token, pull the collection, value each coin
 * (max(metal, numismatic) with fallbacks) and replace the source's positions —
 * which re-rolls the holding's value. disconnect: drop the holding (the FK
 * cascade removes the source + positions).
 *
 * The API key is a SECRET: never logged, never placed in a redirect URL/query.
 * `withStore` is sync-only, so the sync action is structured read creds → await
 * the network → write positions, never awaiting inside a store transaction.
 */

const BASE = "/ajustes";
const NUMISTA_LABEL = "Colección Numista";

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

export async function connectNumistaAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const apiKey = normalizeApiKey(formData.get("apiKey"));
  const returnUrl = currentUrlOf(formData);

  if (!apiKey) {
    redirect(
      errorRedirectUrl(returnUrl, {
        formId: "numista",
        message: "Pega tu clave de API de Numista para conectar la colección.",
      }),
    );
  }

  const scoped = await scopeMemberId();

  const result = runWith((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return { ok: false as const, error: "Workspace no inicializado." };
    }

    // For now only one Numista source is allowed — a second connect is refused
    // so the settings page shows the existing one as connected instead.
    const existing = store.connectedSources
      .listSources()
      .find((source) => source.adapter === "numista");

    if (existing) {
      return { ok: false as const, error: "Ya hay una colección Numista conectada." };
    }

    const ownership = resolveConnectingOwnership(workspace.members, scoped);

    if (!ownership) {
      return {
        ok: false as const,
        error: "No hay ningún miembro activo que pueda ser propietario de la colección.",
      };
    }

    store.connectedSources.connect({
      adapter: "numista",
      label: NUMISTA_LABEL,
      credentialsJson: buildCredentialsJson(apiKey),
      ownership,
    });

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(returnUrl, { formId: "numista", message: result.error }));
  }

  redirect(appendParam(returnUrl, "ok", "numista_connected"));
}

export async function syncNumistaAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const sourceId = parseEntityId(formData, "sourceId");
  const returnUrl = currentUrlOf(formData);

  if (!sourceId) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la fuente conectada de Numista.",
      }),
    );
  }

  // 1) Read the credentials + token (sync, inside the store).
  const source = runWith((store) => store.connectedSources.readSource(sourceId), _store);

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

  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const credentials = { apiKey };

  // 2) Network: mint/refresh the token and pull the valued collection. On any
  // failure, redirect with a clear message and DO NOT touch existing positions.
  try {
    let token = parseNumistaToken(source.tokenJson);

    if (!token || !isTokenValid(token, nowMs)) {
      token = await mintNumistaToken(credentials, nowMs);
      runWith(
        (store) => store.connectedSources.saveToken(sourceId, JSON.stringify(token)),
        _store,
      );
    }

    const validToken = token;
    const drafts = await syncNumistaCollection(
      {
        listItems: () =>
          getCollectedItems(credentials, validToken.accessToken, validToken.userId),
        typeDetail: (typeId) => getTypeDetail(credentials, typeId),
        prices: (typeId, issueId) =>
          getPrices(credentials, typeId, issueId)
            .then((prices) => prices)
            .catch(() => null),
        spotPerOzEur: (metal) => fetchMetalSpotEur(metal, nowIso),
      },
      nowIso,
    );

    // 3) Write: replace positions, re-roll the holding value, stamp last sync,
    // and ripple each newly-seen coin's purchase date into history (ADR 0017).
    runWith(
      (store) =>
        store.syncConnectedSource({ positions: drafts, sourceId, syncedAt: nowIso }),
      _store,
    );
  } catch {
    // A failed mint (wrong key) or unreachable Numista — surface a clear error.
    // The existing positions are left untouched (we never reached the write).
    redirect(
      errorRedirectUrl(returnUrl, {
        message:
          "No se pudo sincronizar con Numista. Revisa la clave de API y la conexión.",
      }),
    );
  }

  redirect(appendParam(returnUrl, "ok", "numista_synced"));
}

export async function disconnectNumistaAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  const sourceId = parseEntityId(formData, "sourceId");
  const returnUrl = currentUrlOf(formData);
  // The disconnect CHOICE (PRD #160 story 21, ADR 0016): "freeze" keeps the
  // holding as a plain hand-maintained one; anything else (the default) removes
  // the live holding while frozen snapshots keep the history.
  const freeze = (formData.get("mode") as string) === "freeze";

  if (!sourceId) {
    redirect(
      errorRedirectUrl(returnUrl, {
        message: "No se encontró la fuente conectada de Numista.",
      }),
    );
  }

  const result = runWith((store) => {
    const source = store.connectedSources.readSource(sourceId);

    if (!source) {
      return { ok: false as const, error: "No se encontró la fuente conectada." };
    }

    if (freeze) {
      // Freeze into a stored holding: drop the source (cascading positions) and
      // flip the kept asset to a hand-valued precious_metal holding.
      const frozen = store.connectedSources.freezeIntoStoredHolding(sourceId);

      if (!frozen) {
        return { ok: false as const, error: "No se pudo congelar la colección." };
      }

      return { ok: true as const, message: "numista_frozen" as const };
    }

    // Remove the live holding: deleting it cascade-deletes the source + positions
    // (schema FKs). hardDeleteAsset only deletes from the trash, so soft-delete
    // first. Frozen snapshots keep the history (a hard delete never touches it).
    store.assets.softDeleteAsset(source.assetId, new Date().toISOString());
    const removed = store.assets.hardDeleteAsset(source.assetId);

    if (removed === 0) {
      return { ok: false as const, error: "No se pudo desconectar la colección." };
    }

    return { ok: true as const, message: "numista_disconnected" as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(returnUrl, { message: result.error }));
  }

  redirect(appendParam(returnUrl, "ok", result.message));
}
