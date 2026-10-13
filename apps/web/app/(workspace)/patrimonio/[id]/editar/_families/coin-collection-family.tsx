/**
 * The Numista coin-collection ficha (PRD #160, ADR 0016).
 *
 * A collection is `derived` like an investment, but its sub-detail is the
 * positions its connected source mirrors — not an operations ledger. So it reads
 * its coins and its own decoupled valuation freshness (PRD #166), and nothing
 * else: no operations, no price cache for a quote it does not have, no traspaso
 * surface.
 *
 * Since #1849 it is a tabbed ficha. Nothing is typed into a mirror, so its bar has
 * no habitual action: «Añadir cobro» by the #1829 rule, and «Desconectar Numista»
 * in «Más». The header carries the value — the board row's figure, said once —
 * how many coins, and when Numista last synced, with the sync beside the date
 * (`mirror-ficha`). Its tabs: «Monedas» (the strip and the equalizer), Cobros and
 * «Datos del activo».
 */

import { NUMISTA_DISCONNECT_FORM_ID } from "@web/ajustes/connected-source-form-ids";
import { DisconnectNumistaForm } from "@web/ajustes/disconnect-numista-fold";
import { syncNumistaAction } from "@web/ajustes/numista-actions";
import { holdingWarnings } from "@web/patrimonio/[id]/editar/_chrome/holding-warnings";
import {
  FICHA_DATOS_TAB,
  fichaTabUrl,
} from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import { CoinCollectionSection } from "@web/patrimonio/[id]/editar/_surfaces/coin-collection-section";
import { buildCoinCollectionView } from "@web/patrimonio/[id]/editar/_surfaces/coin-collection-view";
import type { CoinPosition } from "@worthline/domain";
import { formatMoneyMinorPrivacy, groupPositionsByMetal } from "@worthline/domain";
import type { ConnectedSource } from "./binance-family";
import type {
  AssetFamilyContext,
  FichaAction,
  FichaFigure,
  HoldingSurface,
} from "./family-contract";
import { holdingSurface } from "./family-contract";
import { COBROS_TAB, fichaCobros } from "./ficha-cobros";
import { DISCONNECT_ACTION, syncedFigure } from "./mirror-ficha";

/** «Monedas»: its key. */
const COINS_TAB = "monedas";

/** Its own tabs; the page appends «Datos del activo». «Monedas» opens by default. */
const TABS = [COINS_TAB, COBROS_TAB] as const;

/** Every tab the ficha ends up with, in order — what each URL here is built against. */
const FICHA_TABS = [...TABS, FICHA_DATOS_TAB] as const;

export async function loadCoinCollectionSurface(
  ctx: AssetFamilyContext,
  routedSource: ConnectedSource | null,
): Promise<HoldingSurface> {
  const {
    asset,
    currentUrl,
    formError,
    id,
    isDemo,
    overrides,
    payoutsPanel,
    privacyMode,
    store,
  } = ctx;

  // The source the router resolved from the asset's own back-link, or — for a
  // collection carrying none — the one whose row names this asset. The valuation
  // freshness is this collection's OWN `numista`-source cache row (PRD #166),
  // separate from the investment price cache.
  const source =
    routedSource ??
    (await store.connectedSources.listSources()).find((s) => s.assetId === id) ??
    null;
  const [positions, valuationCache] = await Promise.all([
    source
      ? store.connectedSources.readPositions(source.id)
      : Promise.resolve<never[]>([]),
    store.operations.readPriceCache(id),
  ]);

  const coins = positions.filter((p): p is CoinPosition => p.kind === "coin");
  const groups = groupPositionsByMetal(coins);
  const view = buildCoinCollectionView(
    groups,
    groups.reduce((sum, group) => sum + group.subtotalMinor, 0),
  );
  const cobros = fichaCobros({ currentUrl, payoutsPanel, tabs: FICHA_TABS });
  // A sync, a freeze and a refusal all come back to the ficha as it opens.
  const fichaUrl = fichaTabUrl(currentUrl, FICHA_TABS, COINS_TAB);

  // The valuation rides the daily stale-price pass; on an outage it keeps the
  // last-known value and flags itself stale (ADR 0017) — said under the date.
  const valuationStale =
    valuationCache?.freshnessState === "stale" ||
    valuationCache?.freshnessState === "failed";

  // ── The state header ────────────────────────────────────────────────────────
  const figures: FichaFigure[] = [
    { key: "coins", label: "Monedas", value: String(view.coinCount) },
    syncedFigure({
      lastSyncAt: source?.lastSyncAt ?? null,
      status: valuationStale ? (
        <div className="fichaPriceNotice">
          <span>
            ⚠ Valoración desactualizada.
            {valuationCache?.staleReason ? ` ${valuationCache.staleReason}` : ""} Se
            muestra el último valor conocido.
          </span>
        </div>
      ) : (
        <small className="priceRefreshCaption">Conectado</small>
      ),
      sync: source
        ? {
            action: syncNumistaAction,
            currentUrl: fichaUrl,
            label: "Sincronizar Numista",
            readOnly: isDemo,
            sourceId: source.id,
          }
        : null,
    }),
  ];

  // ── The actions: no habitual one — nothing is typed into a mirror ──────────
  const actions: FichaAction[] = [
    cobros.action,
    ...(source
      ? [
          {
            content: (
              <DisconnectNumistaForm
                currentUrl={fichaUrl}
                formError={formError}
                readOnly={isDemo}
                sourceId={source.id}
              />
            ),
            key: DISCONNECT_ACTION,
            label: "Desconectar Numista",
            tier: "more" as const,
          },
        ]
      : []),
  ];

  return holdingSurface("coin-collection", {
    // «Lo básico» locks the identity fields: name, type and value are the
    // source's, not the user's (ADR 0016).
    basics: { isCoinCollection: true },
    ficha: {
      actions,
      errorTargets: {
        ...cobros.errorTargets,
        [NUMISTA_DISCONNECT_FORM_ID]: { action: DISCONNECT_ACTION },
      },
      figures,
      instrument: "Colección de monedas · Numista",
      // «Desconectar» prints its own refusal, in its panel (#1849).
      ownErrorForms: [NUMISTA_DISCONNECT_FORM_ID],
      rows: payoutsPanel.rows,
      tabs: [
        {
          content: (
            <CoinCollectionSection
              hasSource={source !== null}
              privacyMode={privacyMode}
              view={view}
            />
          ),
          count: view.coinCount,
          key: COINS_TAB,
          label: "Monedas",
        },
        cobros.tab,
      ],
      // The board row's figure, untransformed — not the positions' own sum.
      value: formatMoneyMinorPrivacy(asset.currentValue, privacyMode),
      // No ledger: the band's warnings are about the holding's own row.
      warnings: holdingWarnings({ asset, id, operations: [], overrides }),
    },
  });
}
