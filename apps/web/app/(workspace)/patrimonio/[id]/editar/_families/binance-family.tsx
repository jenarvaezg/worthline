/**
 * The connected Binance crypto ficha (PRD #245, ADR 0021).
 *
 * Like a coin collection, it is `derived` but mirrors positions instead of
 * keeping a ledger. Two things are specific to it: a source materializes ONE
 * asset per rung (market + term-locked, #248), so the asset's own
 * `connected_source_id` back-link — not `connected_sources.asset_id` — is what
 * identifies it, and only the tokens on THIS asset's rung are listed.
 *
 * {@link readBinanceSource} is exported because it is also the routing question:
 * a `crypto` asset with a Binance source belongs to this family, one without is a
 * hand-kept investment. Doing the read here keeps that knowledge in one module,
 * and the surface below reuses the row instead of asking again.
 */

import { BinanceHoldingSection } from "@web/patrimonio/[id]/editar/_surfaces/binance-holding-section";
import { tokenPositionsOnRung } from "@web/patrimonio/[id]/editar/_surfaces/binance-holding-view";
import type { WorthlineStore } from "@web/store";
import type { Instrument } from "@worthline/domain";
import type { AssetFamilyContext, HoldingSurface } from "./family-contract";
import { holdingSurface } from "./family-contract";

type ConnectedSource = Awaited<
  ReturnType<WorthlineStore["connectedSources"]["listSources"]>
>[number];

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
  const { asset, currentUrl, id, payoutsPanel, privacyMode, store } = ctx;

  const [sourcePositions, snapshotRows] = await Promise.all([
    store.connectedSources.readPositions(source.id),
    store.snapshots.readSnapshotHoldings({ holdingId: id, kind: "asset" }),
  ]);

  // The curve start (PRD #245 S5, #250): the earliest snapshot dateKey carrying
  // this asset's frozen row — how far back the reconstructed monthly history
  // reaches. Null until a backfill has run. Surfaced as "Datos desde DD/MM".
  const sinceDateKey = snapshotRows.reduce<string | null>(
    (min, row) => (min === null || row.dateKey < min ? row.dateKey : min),
    null,
  );

  return holdingSurface("binance", {
    // «Lo básico» locks the identity fields: this rung is the source's (ADR 0021).
    basics: { isBinanceHolding: true },
    body: (
      <>
        <BinanceHoldingSection
          currentUrl={currentUrl}
          lastSyncAt={source.lastSyncAt ?? null}
          positions={tokenPositionsOnRung(sourcePositions, asset.liquidityTier)}
          privacyMode={privacyMode}
          sinceDateKey={sinceDateKey}
          sourceId={source.id}
        />
        {payoutsPanel}
      </>
    ),
  });
}
