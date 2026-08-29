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
import type { FamilyContext, HoldingSurface } from "./family-contract";
import { holdingSurface } from "./family-contract";

type ConnectedSource = Awaited<
  ReturnType<WorthlineStore["connectedSources"]["listSources"]>
>[number];

/**
 * The Binance source behind this asset, or null when there is none — which is
 * what tells a mirrored crypto holding from a manual one. Only worth asking of a
 * `crypto` instrument; every other asset answers null without a read.
 */
export async function readBinanceSource(
  store: WorthlineStore,
  input: { assetId: string; instrument: Instrument },
): Promise<ConnectedSource | null> {
  if (input.instrument !== "crypto") {
    return null;
  }

  const sourceId = await store.connectedSources.readSourceIdForAsset(input.assetId);

  if (!sourceId) {
    return null;
  }

  return (
    (await store.connectedSources.listSources()).find(
      (s) => s.id === sourceId && s.adapter === "binance",
    ) ?? null
  );
}

export async function loadBinanceSurface(
  ctx: FamilyContext,
  source: ConnectedSource | null,
): Promise<HoldingSurface> {
  const { asset, currentUrl, id, payoutsPanel, privacyMode, store } = ctx;

  if (!asset || !source) {
    return holdingSurface("binance", { body: null });
  }

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
