import type { StoreContext } from "@db/store-context";
import type { OwnershipShare } from "@worthline/domain";
import type {
  DatedFactCommandImplementations,
  DatedFactStores,
} from "./command-implementation-types";
import {
  rippleHistoricalSnapshotsForOwnership,
  rippleHousingAfterEdit,
} from "./ripple-engine";

/**
 * Whether two ownership splits differ — the signal that an edit must ripple the
 * scope axis (ADR 0020). A reorder of the same members/shares is NOT a change;
 * an added/removed member or a moved share IS. Lives behind the ownership seam so
 * the action layer no longer derives "did ownership change".
 */
function ownershipChanged(before: OwnershipShare[], after: OwnershipShare[]): boolean {
  if (before.length !== after.length) return true;
  const beforeByMember = new Map(before.map((share) => [share.memberId, share.shareBps]));
  return after.some((share) => beforeByMember.get(share.memberId) !== share.shareBps);
}

/**
 * Ownership-split dated-fact commands (ADR 0020, #172): patch an asset's or a
 * liability's ownership and re-weight the scope axis of every affected snapshot.
 * An ownership edit has no time dimension. Depends only on the shared ripple
 * engine.
 */
export function createOwnershipCommands(
  ctx: StoreContext,
  stores: DatedFactStores,
): Pick<
  DatedFactCommandImplementations,
  "updateAssetAndRippleOwnership" | "updateLiabilityAndRippleOwnership"
> {
  return {
    updateAssetAndRippleOwnership: async (assetId, patch, opts) => {
      const today = opts?.today ?? new Date().toISOString().slice(0, 10);
      // One transaction so the patch + the scope-axis ripple commit or roll back
      // together (ADR 0020). The previous ownership and the did-it-change
      // comparison are read behind the seam, not at the call site.
      await ctx.transaction(async () => {
        const before =
          (await stores.assets.readAssets()).find((a) => a.id === assetId) ?? null;
        await stores.assets.updateAsset(assetId, patch);
        // A real_estate asset re-weights through the housing curve ripple — it
        // already re-derives every affected snapshot from the asset's new split,
        // so it covers an ownership edit too (and a from-date in the future is
        // guarded inside the helper).
        const type = patch.type ?? before?.type;
        if (type === "real_estate") {
          await rippleHousingAfterEdit(
            ctx,
            { assets: stores.assets, snapshots: stores.snapshots },
            assetId,
            today,
          );
          return;
        }
        // A non-real_estate ownership-split change rides the scope-axis ripple;
        // a cosmetic edit (same split) ripples nothing.
        if (
          before &&
          patch.ownership &&
          ownershipChanged(before.ownership, patch.ownership)
        ) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForOwnership(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                holdingId: assetId,
                kind: "asset",
                previousOwnership: before.ownership,
              },
            );
          }
        }
      });
    },
    updateLiabilityAndRippleOwnership: (liabilityId, patch) => {
      // An ownership edit has no time axis, so the liability seam takes no `today`
      // (the uniform `opts` is accepted at the type level for symmetry with the
      // asset seam, but unused here).
      // One transaction so the patch + the scope-axis ripple commit or roll back
      // together (ADR 0020). The previous ownership and the did-it-change
      // comparison are read behind the seam.
      return ctx.transaction(async () => {
        const before =
          (await stores.liabilities.readLiabilities()).find(
            (l) => l.id === liabilityId,
          ) ?? null;
        await stores.liabilities.updateLiability(liabilityId, patch);
        if (
          before &&
          patch.ownership &&
          ownershipChanged(before.ownership, patch.ownership)
        ) {
          const workspace = await ctx.getWorkspace();
          if (workspace) {
            await rippleHistoricalSnapshotsForOwnership(
              ctx,
              workspace,
              stores.snapshots.saveSnapshot,
              {
                holdingId: liabilityId,
                kind: "liability",
                previousOwnership: before.ownership,
              },
            );
          }
        }
      });
    },
  };
}
