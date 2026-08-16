import { isPremiumIngestionAllowed } from "@web/entitlements/effective-plan";
import {
  PAYWALL_CONNECT_SOURCE_MESSAGE,
  PAYWALL_SOURCES_PAUSED_MESSAGE,
} from "@web/entitlements/paywall-copy";
import { PremiumNotice } from "@web/entitlements/premium-notice";
import { readEffectivePlan } from "@web/entitlements/read-effective-plan";
import FormRouteSkeleton from "@web/form-route-skeleton";
import {
  holdingDetailHref,
  holdingPublicIdOf,
  readHoldingPublicIdIndex,
} from "@web/holding-route";
import { buildCurrentUrlFor, parseFormError, resolveOkMessage } from "@web/intake";
import { resolvePageShell } from "@web/page-shell";
import { readStoreTarget } from "@web/read-store-target";
import { Suspense } from "react";
import { CONNECTION_REGISTRY } from "./connection-registry";
import { loadConnectionRows } from "./connection-rows";
import ConnectionsTable, { type ConnectionEntry } from "./connections-table";

/**
 * «Conexiones» (#1223, PRD #1222) — las fuentes vivas, fuera del monolito de
 * `/ajustes`. La página no conoce a Numista ni a Binance: itera el registry de
 * UI y le pide a cada adapter cómo se llama, qué cuenta y qué acciones lo
 * mueven. En `/ajustes` queda una tarjeta-resumen con enlace aquí.
 *
 * El import de extractos NO vive aquí: no es una fuente viva (sin credenciales
 * ni sync recurrente) y sigue en `/patrimonio/importar-extracto`.
 */
export default function ConexionesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<FormRouteSkeleton label="Cargando conexiones" />}>
      <ConexionesContent searchParams={searchParams} />
    </Suspense>
  );
}

export async function ConexionesContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  const resolvedSearchParams = await searchParams;
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/ajustes/conexiones", resolvedSearchParams);

  const { privacyMode, store } = await resolvePageShell({
    searchParams: resolvedSearchParams,
  });

  const sources = await store.connectedSources.listSources();
  const allAssets = await store.assets.readAssets();

  // El enlace «Ver →» abre la ficha del activo espejo, direccionada por su id
  // público `wl_hld_…` (#1318) — nunca por el interno. Un holding sin fila en el
  // registro pierde el enlace en vez de tirar la página entera.
  const publicIds = await readHoldingPublicIdIndex(store);
  const rows = await loadConnectionRows({
    assets: allAssets,
    definitions: CONNECTION_REGISTRY,
    hrefOf: (assetId) => {
      const publicId = holdingPublicIdOf(publicIds, assetId);
      return publicId ? holdingDetailHref(publicId) : null;
    },
    sources,
    store: store.connectedSources,
  });

  const connections: ConnectionEntry[] = CONNECTION_REGISTRY.map((definition, index) => ({
    definition,
    row: rows[index]!,
  }));
  const connectedCount = rows.filter((row) => row.source !== null).length;

  // Las fuentes conectadas son ingesta premium (#1162): un workspace free
  // conserva lo ya importado, pero ve un aviso honesto de pausa en vez de
  // sincronizar. La banda va en la cabecera de la página, no por conexión: el
  // plan es del workspace entero, no de una fuente.
  const sourcesGated = !isPremiumIngestionAllowed(
    await readEffectivePlan(await readStoreTarget()),
  );

  return (
    <section className="section" aria-label="Conexiones">
      <div className="panelHeader">
        <h2>Conexiones</h2>
        <span>
          {connectedCount} de {CONNECTION_REGISTRY.length}{" "}
          {CONNECTION_REGISTRY.length === 1 ? "fuente conectada" : "fuentes conectadas"}
        </span>
      </div>

      {formError ? (
        <p className="errorBand" role="alert">
          {formError.message}
        </p>
      ) : null}

      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      {sourcesGated ? (
        <PremiumNotice
          cta={false}
          message={
            connectedCount > 0
              ? PAYWALL_SOURCES_PAUSED_MESSAGE
              : PAYWALL_CONNECT_SOURCE_MESSAGE
          }
        />
      ) : null}

      <ConnectionsTable
        connections={connections}
        currentUrl={currentUrl}
        errorFormId={formError?.formId ?? null}
        privacyMode={privacyMode}
      />
    </section>
  );
}
