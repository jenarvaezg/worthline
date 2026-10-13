/**
 * The connected Binance crypto ficha (PRD #245, ADR 0021).
 *
 * Like a coin collection, it is `derived` but mirrors positions instead of
 * keeping a ledger. Two things are specific to it: a source materializes ONE
 * asset per rung (market + term-locked, #248), so the asset's own
 * `connected_source_id` back-link — not `connected_sources.asset_id` — is what
 * identifies it, and only the tokens on THIS asset's rung are listed.
 *
 * {@link readConnectedSourceOfAsset} is exported because it is also the routing
 * question: a `crypto` asset with a Binance source belongs to this family, one
 * without is a hand-kept investment. Doing the read here keeps that knowledge in
 * one module, and the surface below reuses the row instead of asking again.
 *
 * Since #1849 it is a tabbed ficha, the collection's twin (`mirror-ficha`): no
 * habitual action, «Añadir cobro» by the #1829 rule, «Desconectar Binance» in
 * «Más». The header names the rung — each is its own asset — and carries the
 * board's value, how many tokens, when Binance last synced (with the sync beside
 * it) and how far back the reconstructed history reaches. Its tabs: «Tokens»,
 * Cobros and «Datos del activo».
 */

import { syncBinanceAction } from "@web/ajustes/binance-actions";
import { BINANCE_DISCONNECT_FORM_ID } from "@web/ajustes/connected-source-form-ids";
import { DisconnectBinanceForm } from "@web/ajustes/disconnect-binance-fold";
import { holdingWarnings } from "@web/patrimonio/[id]/editar/_chrome/holding-warnings";
import {
  FICHA_DATOS_TAB,
  fichaTabUrl,
} from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import { BinanceHoldingSection } from "@web/patrimonio/[id]/editar/_surfaces/binance-holding-section";
import {
  buildBinanceHoldingView,
  tokenPositionsOnRung,
} from "@web/patrimonio/[id]/editar/_surfaces/binance-holding-view";
import type { WorthlineStore } from "@web/store";
import {
  formatDateKeyEs,
  formatMoneyMinorPrivacy,
  LIQUIDITY_TIER_LABELS,
} from "@worthline/domain";
import type {
  AssetFamilyContext,
  FichaAction,
  FichaFigure,
  HoldingSurface,
} from "./family-contract";
import { holdingSurface } from "./family-contract";
import { COBROS_TAB, fichaCobros } from "./ficha-cobros";
import { DISCONNECT_ACTION, syncedFigure } from "./mirror-ficha";

/** A connected source's row, as the store lists it. */
export type ConnectedSource = Awaited<
  ReturnType<WorthlineStore["connectedSources"]["listSources"]>
>[number];

/** «Tokens»: its key. */
const TOKENS_TAB = "tokens";

/** Its own tabs; the page appends «Datos del activo». «Tokens» opens by default. */
const TABS = [TOKENS_TAB, COBROS_TAB] as const;

/** Every tab the ficha ends up with, in order — what each URL here is built against. */
const FICHA_TABS = [...TABS, FICHA_DATOS_TAB] as const;

/**
 * The Binance source behind this asset, or null when there is none — which is
 * what tells a mirrored crypto holding from a manual one. Only worth asking of a
 * `crypto` instrument; every other asset answers null without a read.
 */
export async function readConnectedSourceOfAsset(
  store: WorthlineStore,
  asset: { id: string; connectedSourceId?: string | null },
): Promise<ConnectedSource | null> {
  // Gated on the asset's own back-link column, not on its instrument (#1691): the
  // instrument can be a stale backfill artefact, the back-link cannot — it is what
  // the sync itself matches on. A hand-kept holding carries none, so it still pays
  // for no read.
  if (asset.connectedSourceId == null) {
    return null;
  }

  return (
    (await store.connectedSources.listSources()).find(
      (source) => source.id === asset.connectedSourceId,
    ) ?? null
  );
}

export async function loadBinanceSurface(
  ctx: AssetFamilyContext,
  source: ConnectedSource,
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

  const [sourcePositions, snapshotRows] = await Promise.all([
    store.connectedSources.readPositions(source.id),
    store.snapshots.readSnapshotHoldings({ holdingId: id, kind: "asset" }),
  ]);

  // The curve start (PRD #245 S5, #250): the earliest snapshot dateKey carrying
  // this asset's frozen row — how far back the reconstructed monthly history
  // reaches. Null until a backfill has run, and then the header claims none.
  const sinceDateKey = snapshotRows.reduce<string | null>(
    (min, row) => (min === null || row.dateKey < min ? row.dateKey : min),
    null,
  );

  const view = buildBinanceHoldingView(
    tokenPositionsOnRung(sourcePositions, asset.liquidityTier),
  );
  const cobros = fichaCobros({ currentUrl, payoutsPanel, tabs: FICHA_TABS });
  // A sync, a freeze and a refusal all come back to the ficha as it opens.
  const fichaUrl = fichaTabUrl(currentUrl, FICHA_TABS, TOKENS_TAB);

  // ── The state header ────────────────────────────────────────────────────────
  const figures: FichaFigure[] = [
    { key: "tokens", label: "Tokens", value: String(view.tokenCount) },
    syncedFigure({
      lastSyncAt: source.lastSyncAt ?? null,
      status: <small className="priceRefreshCaption">Conectado</small>,
      sync: {
        action: syncBinanceAction,
        currentUrl: fichaUrl,
        label: "Sincronizar Binance",
        readOnly: isDemo,
        sourceId: source.id,
      },
    }),
    ...(sinceDateKey
      ? [{ key: "since", label: "Histórico desde", value: formatDateKeyEs(sinceDateKey) }]
      : []),
  ];

  // ── The actions: no habitual one — nothing is typed into a mirror ──────────
  const actions: FichaAction[] = [
    cobros.action,
    {
      content: (
        <DisconnectBinanceForm
          currentUrl={fichaUrl}
          formError={formError}
          readOnly={isDemo}
          sourceId={source.id}
        />
      ),
      key: DISCONNECT_ACTION,
      label: "Desconectar Binance",
      tier: "more",
    },
  ];

  return holdingSurface("binance", {
    // «Lo básico» locks the identity fields: this rung is the source's (ADR 0021).
    basics: { isBinanceHolding: true },
    ficha: {
      actions,
      errorTargets: {
        ...cobros.errorTargets,
        [BINANCE_DISCONNECT_FORM_ID]: { action: DISCONNECT_ACTION },
      },
      figures,
      // Each rung is its own asset (#248): the instrument says which.
      instrument: `Cripto · Binance · ${LIQUIDITY_TIER_LABELS[asset.liquidityTier]}`,
      // «Desconectar» prints its own refusal, in its panel (#1849).
      ownErrorForms: [BINANCE_DISCONNECT_FORM_ID],
      rows: payoutsPanel.rows,
      tabs: [
        {
          content: <BinanceHoldingSection privacyMode={privacyMode} view={view} />,
          count: view.tokenCount,
          key: TOKENS_TAB,
          label: "Tokens",
        },
        cobros.tab,
      ],
      // The board row's figure, untransformed — not the tokens' own sum.
      value: formatMoneyMinorPrivacy(asset.currentValue, privacyMode),
      // No ledger: the band's warnings are about the holding's own row.
      warnings: holdingWarnings({ asset, id, operations: [], overrides }),
    },
  });
}
