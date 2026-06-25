"use server";

import { type WorthlineStore } from "@worthline/db";
import type { CoinPosition } from "@worthline/domain";
import {
  fetchMetalSpotEur,
  getCollectedItems,
  getPrices,
  getTypeDetail,
  isTokenValid,
  type MetalKind,
  mintNumistaToken,
  numistaAdapter,
} from "@worthline/pricing";

import { runActionWithStore } from "@web/action-store";
import { parseEntityId } from "@web/intake";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  connectSource,
  currentUrlOf,
  disconnectSource,
  syncSource,
} from "./connected-source-lifecycle";
import { parseNumistaToken } from "./numista-helpers";

/**
 * Server actions for the Numista connected source (PRD #160 / #163, ADR 0016/0017).
 * Since #319 (ADR 0027) these are thin wrappers over the GENERIC connect/sync/
 * disconnect lifecycle (`connected-source-lifecycle.ts`), parameterized by the
 * Numista adapter (`numistaAdapter`). Numista-specific parsing + valuation live in
 * the adapter; this file only wires the real OAuth-gated network readers into the
 * sync context (mint/refresh the token, then the token-bound collection reads).
 *
 * The API key is a SECRET: never logged, never placed in a redirect URL/query.
 * `withStore` is sync-only, so the sync wiring mints/refreshes the token and lists
 * the collection OUTSIDE the store, never awaiting inside a store transaction.
 */

const NUMISTA_LABEL = "Colección Numista";

export async function connectNumistaAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  await guardDemoWrite("/ajustes");
  return connectSource(
    numistaAdapter,
    formData,
    {
      formId: "numista",
      missingCredentials: "Pega tu clave de API de Numista para conectar la colección.",
      alreadyConnected: "Ya hay una colección Numista conectada.",
      noOwner: "No hay ningún miembro activo que pueda ser propietario de la colección.",
      label: NUMISTA_LABEL,
      okParam: "numista_connected",
    },
    _store,
  );
}

export async function syncNumistaAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  await guardDemoWrite(currentUrlOf(formData));
  const sourceId = parseEntityId(formData, "sourceId");

  return syncSource(
    numistaAdapter,
    sourceId,
    {
      notFound: "No se encontró la fuente conectada de Numista.",
      missingCredentials:
        "La clave de API de Numista no está disponible. Vuelve a conectar la colección.",
      syncFailed:
        "No se pudo sincronizar con Numista. Revisa la clave de API y la conexión.",
      okParam: "numista_synced",
      parseToken: parseNumistaToken,
      // Mint/refresh the OAuth token (persisting a freshly-minted one), then bind
      // the token to the real Numista collection readers + a Stooq/ECB spot
      // resolver. Awaited OUTSIDE the store write, as the sync ordering demands.
      buildContext: async ({ creds, token, nowIso, nowMs, persistToken }) => {
        let validToken = token;

        if (!validToken || !isTokenValid(validToken, nowMs)) {
          validToken = await mintNumistaToken(creds, nowMs);
          persistToken(validToken);
        }

        const bound = validToken;

        // Hand the sync the coins we already have so it can skip re-calling Numista
        // for static type detail + still-fresh estimates (ADR 0017 request-cap, #602).
        // `sourceId` is non-null here — syncSource validated it before buildContext runs.
        const existingCoins = (
          await runActionWithStore(
            (store) => store.connectedSources.readPositions(sourceId!),
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

        return {
          creds,
          token: bound,
          saveToken: persistToken,
          nowIso,
          nowMs,
          existingCoins,
          listItems: () => getCollectedItems(creds, bound.accessToken, bound.userId),
          typeDetail: (typeId) => getTypeDetail(creds, typeId),
          prices: (typeId, issueId) =>
            getPrices(creds, typeId, issueId)
              .then((prices) => prices)
              .catch(() => null),
          spotPerOzEur: (metal) => fetchMetalSpotEur(metal, nowIso),
        };
      },
    },
    currentUrlOf(formData),
    _store,
  );
}

export async function disconnectNumistaAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
  await guardDemoWrite(currentUrlOf(formData));
  const sourceId = parseEntityId(formData, "sourceId");
  // The disconnect CHOICE (PRD #160 story 21, ADR 0016): "freeze" keeps the
  // holding as a plain hand-maintained one; anything else (the default) removes
  // the live holding while frozen snapshots keep the history.
  const freeze = (formData.get("mode") as string) === "freeze";

  return disconnectSource(
    sourceId,
    freeze,
    {
      notFound: "No se encontró la fuente conectada de Numista.",
      freezeFailed: "No se pudo congelar la colección.",
      removeFailed: "No se pudo desconectar la colección.",
      frozenParam: "numista_frozen",
      disconnectedParam: "numista_disconnected",
    },
    currentUrlOf(formData),
    _store,
  );
}
