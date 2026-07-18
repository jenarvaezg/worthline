/**
 * Baja/restauración proposal builders (#1106, PRD #1103 S3). They turn a
 * chat-declared «quita estos holdings» / «restaura estos» into a persisted
 * `holding_removal` / `holding_restoration` assistant proposal: a **reversible**
 * batch against the papelera (soft delete / restore, #1086) over the existing
 * `softDeleteAsset` / `restoreAsset` seams — NO new persistence. Both write
 * nothing to the portfolio: the app applies the batch atomically on confirm
 * through `batchSoftDeleteHoldings` / `batchRestoreHoldings`.
 *
 * Every warning is **informative and never blocks** (#1086): the net-worth
 * impact, a debt left without its associated asset (orphan pair), shared
 * ownership, and — on restauración — a live-holding duplicate. The one hard error
 * is a **validity** failure: restoring a holding that is not in the papelera.
 */

import { createHash } from "node:crypto";
import { publicIdMap } from "@web/agent-view/scope-resolution";
import type { AgentViewReadStore, AssistantProposalStore } from "@worthline/db";
import {
  formatMoneyMinor,
  type Instrument,
  type Liability,
  type ManualAsset,
  type MatchPortfolioHolding,
  matchHoldings,
  reassignToNew,
} from "@worthline/domain";
import {
  type HoldingTrashImpact,
  holdingTrashImpact,
  signedContributionMinor,
} from "./holding-trash-impact";
import {
  HOLDING_REMOVAL_FOLIO,
  HOLDING_RESTORATION_FOLIO,
  type HoldingTrashDuplicate,
  type HoldingTrashLine,
  type HoldingTrashOrphanPair,
  type HoldingTrashProposal,
} from "./holding-trash-proposal-contract";
import { instrumentLabel } from "./instrument-labels";
import { readScopeNetWorthBeforeMinor } from "./proposal-net-worth";

type ProposalStore = {
  assistantProposals: AssistantProposalStore;
  agentView: AgentViewReadStore;
};

export type BuildTrashResult =
  | { ok: true; proposal: HoldingTrashProposal }
  | { ok: false; error: string };

/** Total ownership bps of a holding (sum of member shares). */
function totalOwnershipBps(ownership: readonly { shareBps: number }[]): number {
  return ownership.reduce((sum, share) => sum + share.shareBps, 0);
}

/** Whether a holding has more than one owner member (informative shared note). */
function isSharedOwnership(ownership: readonly { memberId: string }[]): boolean {
  return new Set(ownership.map((share) => share.memberId)).size > 1;
}

const euros = (minor: number): string =>
  formatMoneyMinor({ amountMinor: minor, currency: "EUR" });

/** Project the live portfolio into matcher holdings for the duplicate warning. */
async function projectLiveHoldings(
  store: ProposalStore,
  assets: ManualAsset[],
  liabilities: Liability[],
): Promise<MatchPortfolioHolding[]> {
  const meta = await store.agentView.readInvestmentAssetsWithMeta();
  const metaBy = new Map(meta.map((row) => [row.id, row]));
  const assetHoldings: MatchPortfolioHolding[] = assets.map((asset) => {
    const isin = metaBy.get(asset.id)?.isin;
    const providerSymbol = asset.providerSymbol ?? metaBy.get(asset.id)?.providerSymbol;
    return {
      holdingId: asset.id,
      name: asset.name,
      ...(asset.instrument ? { instrument: asset.instrument } : {}),
      ...(isin ? { isin } : {}),
      ...(providerSymbol ? { providerSymbol } : {}),
    };
  });
  const liabilityHoldings: MatchPortfolioHolding[] = liabilities.map((liability) => ({
    holdingId: liability.id,
    name: liability.name,
  }));
  return [...assetHoldings, ...liabilityHoldings];
}

/** Persist the batch as one proposal with a fact per targeted holding. */
async function persistTrashProposal(
  store: ProposalStore,
  kind: "holding_removal" | "holding_restoration",
  action: "remove" | "restore",
  targets: readonly { internalId: string; kind: "asset" | "liability"; name: string }[],
): Promise<string> {
  const proposal = await store.assistantProposals.create({ kind });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name: "declaración-del-usuario",
      provenance: "user",
      sha256: createHash("sha256")
        .update(JSON.stringify({ action, targets }))
        .digest("hex"),
    },
    facts: targets.map((target) => ({
      kind: "holding_trash_action" as const,
      row: {
        action,
        holdingId: target.internalId,
        holdingKind: target.kind,
        name: target.name,
      },
    })),
  });
  return proposal.id;
}

/**
 * The baja proposal (#1106): a reversible soft-delete batch of the named live
 * holdings. Warnings are all informative — impact, orphan debt↔asset pairs, and
 * shared ownership. The one error is an unknown/already-trashed id (nothing to
 * remove).
 */
export async function buildHoldingRemovalProposal(
  store: ProposalStore,
  publicHoldingIds: readonly string[],
  today: string,
): Promise<BuildTrashResult> {
  const requested = [...new Set(publicHoldingIds.map((id) => id.trim()).filter(Boolean))];
  if (requested.length === 0) {
    return { error: "No has indicado ningún holding a dar de baja.", ok: false };
  }

  const { assets, liabilities } = await store.agentView.readCurveValuedHoldings(today);
  const publicByInternal = publicIdMap(await store.agentView.readPublicIds(), "holding");

  const assetByPublic = new Map(
    assets.map((asset) => [publicByInternal.get(asset.id), asset]),
  );
  const liabilityByPublic = new Map(
    liabilities.map((liability) => [publicByInternal.get(liability.id), liability]),
  );

  const lines: HoldingTrashLine[] = [];
  const targets: { internalId: string; kind: "asset" | "liability"; name: string }[] = [];
  const removedAssetIds = new Set<string>();
  const removedInternalIds = new Set<string>();
  for (const publicId of requested) {
    const asset = assetByPublic.get(publicId);
    const liability = liabilityByPublic.get(publicId);
    if (asset) {
      const bps = totalOwnershipBps(asset.ownership);
      lines.push({
        contributionMinor: signedContributionMinor(
          asset.currentValue.amountMinor,
          bps,
          1,
        ),
        detail: euros(asset.currentValue.amountMinor),
        holdingId: publicId,
        instrumentLabel: instrumentLabel(asset.instrument, "Activo"),
        kind: "asset",
        name: asset.name,
        sharedOwnership: isSharedOwnership(asset.ownership),
      });
      targets.push({ internalId: asset.id, kind: "asset", name: asset.name });
      removedAssetIds.add(asset.id);
      removedInternalIds.add(asset.id);
    } else if (liability) {
      const bps = totalOwnershipBps(liability.ownership);
      lines.push({
        contributionMinor: signedContributionMinor(
          liability.currentBalance.amountMinor,
          bps,
          -1,
        ),
        detail: euros(liability.currentBalance.amountMinor),
        holdingId: publicId,
        instrumentLabel: liability.type === "mortgage" ? "Hipoteca" : "Deuda",
        kind: "liability",
        name: liability.name,
        sharedOwnership: isSharedOwnership(liability.ownership),
      });
      targets.push({ internalId: liability.id, kind: "liability", name: liability.name });
      removedInternalIds.add(liability.id);
    } else {
      return {
        error: `No encuentro «${publicId}» entre tus holdings activos; quizá ya esté en la papelera.`,
        ok: false,
      };
    }
  }

  // Orphan debt↔asset pairs: a debt whose associated asset is being removed while
  // the debt itself stays behind (informative, #1086).
  const orphanPairs: HoldingTrashOrphanPair[] = [];
  for (const liability of liabilities) {
    if (
      liability.associatedAssetId &&
      removedAssetIds.has(liability.associatedAssetId) &&
      !removedInternalIds.has(liability.id)
    ) {
      const asset = assets.find((item) => item.id === liability.associatedAssetId);
      orphanPairs.push({
        assetName: asset?.name ?? "el activo asociado",
        debtName: liability.name,
      });
    }
  }

  const impact = holdingTrashImpact(
    await readScopeNetWorthBeforeMinor(store.agentView, today),
    "remove",
    lines,
  );
  const proposalId = await persistTrashProposal(
    store,
    "holding_removal",
    "remove",
    targets,
  );

  return {
    ok: true,
    proposal: trashProposal(
      "holding_removal",
      "remove",
      HOLDING_REMOVAL_FOLIO,
      proposalId,
      lines,
      impact,
      orphanPairs,
      [],
    ),
  };
}

/**
 * The restauración proposal (#1106): the mirror of the baja — restore the named
 * trashed holdings. A requested id that is NOT in the papelera is a validity
 * error (never a warning). The informative warning here is a live-holding
 * duplicate (restoring recreates something you already have).
 */
export async function buildHoldingRestorationProposal(
  store: ProposalStore,
  publicHoldingIds: readonly string[],
  today: string,
): Promise<BuildTrashResult> {
  const requested = [...new Set(publicHoldingIds.map((id) => id.trim()).filter(Boolean))];
  if (requested.length === 0) {
    return { error: "No has indicado ningún holding a restaurar.", ok: false };
  }

  const trashed = await store.agentView.readTrashedHoldings();
  const publicByInternal = publicIdMap(await store.agentView.readPublicIds(), "holding");
  const trashedByPublic = new Map(
    trashed.map((holding) => [publicByInternal.get(holding.id), holding]),
  );

  const lines: HoldingTrashLine[] = [];
  const targets: { internalId: string; kind: "asset" | "liability"; name: string }[] = [];
  const restored: { name: string; instrument: string | null }[] = [];
  for (const publicId of requested) {
    const holding = trashedByPublic.get(publicId);
    if (!holding) {
      // Validity error (not a warning): the id names a holding that is not in the
      // papelera, so there is nothing to restore.
      return {
        error: `«${publicId}» no está en la papelera, así que no puedo restaurarlo.`,
        ok: false,
      };
    }
    const bps = totalOwnershipBps(holding.ownership);
    const value = holding.valueMinor ?? 0;
    lines.push({
      contributionMinor: signedContributionMinor(
        value,
        bps,
        holding.kind === "asset" ? 1 : -1,
      ),
      detail: euros(value),
      holdingId: publicId,
      instrumentLabel: instrumentLabel(
        holding.instrument,
        holding.kind === "asset" ? "Activo" : "Deuda",
      ),
      kind: holding.kind,
      name: holding.name,
      sharedOwnership: isSharedOwnership(holding.ownership),
    });
    targets.push({ internalId: holding.id, kind: holding.kind, name: holding.name });
    restored.push({ instrument: holding.instrument, name: holding.name });
  }

  // Live-holding duplicate warning (informative): run each restored row through
  // the S1 matcher against the live portfolio and read the surviving candidate.
  const { assets, liabilities } = await store.agentView.readCurveValuedHoldings(today);
  const liveHoldings = await projectLiveHoldings(store, assets, liabilities);
  const duplicates: HoldingTrashDuplicate[] = [];
  restored.forEach((row, index) => {
    const matched = reassignToNew(
      matchHoldings(
        [
          {
            rowId: `restore-${index}`,
            name: row.name,
            ...(row.instrument ? { instrument: row.instrument as Instrument } : {}),
          },
        ],
        liveHoldings,
      )[0]!,
    );
    const candidate = matched.possibleDuplicate;
    if (candidate) {
      duplicates.push({
        confidence: candidate.confidence === "strong" ? "strong" : "weak",
        liveName: candidate.name,
        name: row.name,
      });
    }
  });

  const impact = holdingTrashImpact(
    await readScopeNetWorthBeforeMinor(store.agentView, today),
    "restore",
    lines,
  );
  const proposalId = await persistTrashProposal(
    store,
    "holding_restoration",
    "restore",
    targets,
  );

  return {
    ok: true,
    proposal: trashProposal(
      "holding_restoration",
      "restore",
      HOLDING_RESTORATION_FOLIO,
      proposalId,
      lines,
      impact,
      [],
      duplicates,
    ),
  };
}

/** Assemble the client-facing proposal shape shared by both operations. */
function trashProposal(
  proposalType: "holding_removal" | "holding_restoration",
  operation: "remove" | "restore",
  folio: string,
  proposalId: string,
  lines: HoldingTrashLine[],
  impact: HoldingTrashImpact,
  orphanPairs: HoldingTrashOrphanPair[],
  duplicates: HoldingTrashDuplicate[],
): HoldingTrashProposal {
  return {
    draft: { proposalId },
    duplicates,
    folio,
    impact,
    lines,
    operation,
    orphanPairs,
    proposalType,
  };
}
