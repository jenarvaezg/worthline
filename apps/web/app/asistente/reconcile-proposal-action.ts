"use server";

import {
  isClock,
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import {
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
} from "@web/demo/write-guard";
import { createStableId, resolveOwnershipSplit } from "@web/intake";
import { readStoreTarget } from "@web/read-store-target";
import type { WorthlineStore } from "@web/store";
import type { AssistantProposal, ReconcileDocument } from "@worthline/db";
import type { CreateInvestmentOperationInput, OwnershipShare } from "@worthline/domain";
import { defaultsFor, systemClock } from "@worthline/domain";

import type { ExtractedPositionsMovementsDocument } from "./attachment-extraction-contract";
import { movementLinksToHolding } from "./attachment-extraction-contract";
import { mapReconcileTypeToInstrument } from "./reconcile-instrument-mapping";
import { buildReconcileRows, type ReconcileRow } from "./reconcile-plan";
import {
  parseReconcileCuration,
  parseReconcileProposalDraft,
  type ReconcileCuration,
} from "./reconcile-proposal-contract";
import {
  connectedReconcileAssetIds,
  projectReconcilePortfolio,
} from "./reconcile-proposals";

type ActionResult =
  | { status: "applied"; created: number; updated: number }
  | { status: "discarded" }
  | { status: "blocked"; message: string }
  | { status: "error"; message: string };

type ReconcileFunds = Parameters<
  WorthlineStore["command"]["applyAssistantReconcileProposal"]
>[0]["funds"];

const INVESTMENT_INSTRUMENTS = new Set([
  "fund",
  "etf",
  "stock",
  "index",
  "pension_plan",
  "crypto",
]);

/** The demo / impersonation write barrier (ADR 0044/0057). */
async function guardWrites(): Promise<{ status: "blocked"; message: string } | null> {
  const target = await readStoreTarget();
  if (target.kind === "demo")
    return { message: DEMO_DISABLED_MESSAGE, status: "blocked" };
  if (target.kind === "authenticated" && target.impersonatedEmail !== undefined) {
    return { message: IMPERSONATION_READONLY_MESSAGE, status: "blocked" };
  }
  return null;
}

/** The single positions + movements document a `reconcile` proposal carries. */
function reconcileDocumentOf(proposal: AssistantProposal): ReconcileDocument | null {
  const fact = proposal.documents
    .flatMap((document) => document.facts)
    .find((item) => item.kind === "holding_reconcile");
  return fact && fact.kind === "holding_reconcile" ? fact.row : null;
}

/** The row index a `row-N` id points at, or null when it is not a batch id. */
function rowIndex(rowId: string): number | null {
  const match = /^row-(\d+)$/.exec(rowId);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

/**
 * Map a holding's linked movements to investment operations. A movement carries an
 * amount and an optional unit count: with units the per-unit price is derived, and
 * without them a single synthetic unit priced at the amount keeps the cash value
 * honest without inventing a quantity (ADR 0048). Non-EUR movements are skipped —
 * they cannot be valued here without inventing a rate.
 */
function operationsFromMovements(
  document: ReconcileDocument,
  holding: ReconcileDocument["holdings"][number],
  assetId: string,
  seed: number,
): CreateInvestmentOperationInput[] {
  const linked = document.movements.filter(
    (movement) =>
      movementLinksToHolding(movement, holding) &&
      movement.currency.toUpperCase() === "EUR",
  );
  return linked.map((movement, ordinal) => {
    const hasUnits = typeof movement.units === "number" && movement.units > 0;
    const units = hasUnits ? String(movement.units) : "1";
    const pricePerUnit = hasUnits
      ? String(movement.amount / (movement.units as number))
      : String(movement.amount);
    return {
      assetId,
      currency: "EUR",
      executedAt: movement.date,
      feesMinor: 0,
      id: createStableId("op", `${assetId}_${movement.date}_${ordinal}`, seed + ordinal),
      kind: movement.kind === "sell" ? "sell" : "buy",
      pricePerUnit,
      source: "agent",
      units,
    };
  });
}

/** A single opening BUY valuing a created holding at its current state (ADR 0056). */
function openingOperation(
  holding: ReconcileDocument["holdings"][number],
  assetId: string,
  today: string,
  seed: number,
): CreateInvestmentOperationInput {
  return {
    assetId,
    currency: "EUR",
    executedAt: today,
    feesMinor: 0,
    id: createStableId("op", `${assetId}_opening`, seed),
    kind: "buy",
    pricePerUnit: String(holding.value),
    source: "agent",
    units: "1",
  };
}

/**
 * Resolve the curated batch into a statement-import `funds` array. Only investment,
 * EUR rows in the v1 write scope produce a fund; a create becomes a `new` fund
 * (valued by its movements, or by a current-state opening BUY when it has none), a
 * movement-backed update becomes a `matched` fund that appends its movements, and
 * everything else is honestly left. Reads only — the atomic write happens in the
 * command host.
 */
function resolveFunds(
  document: ReconcileDocument,
  curation: ReconcileCuration[],
  rowById: ReadonlyMap<string, ReconcileRow>,
  investmentAssetIds: ReadonlySet<string>,
  ownership: OwnershipShare[],
  today: string,
  seed: number,
): ReconcileFunds {
  const funds: ReconcileFunds = [];
  for (const [index, entry] of curation.entries()) {
    const rowAt = rowIndex(entry.rowId);
    if (rowAt === null) continue;
    const holding = document.holdings[rowAt];
    if (!holding) continue;
    if (holding.currency.toUpperCase() !== "EUR") continue;
    const instrument = mapReconcileTypeToInstrument(holding.type);
    if (!instrument || !INVESTMENT_INSTRUMENTS.has(instrument)) continue;
    const fundSeed = seed + index * 1000;

    if (entry.decision === "create") {
      const assetId = createStableId("asset", `${holding.name}_${entry.rowId}`, fundSeed);
      const movementOps = operationsFromMovements(document, holding, assetId, fundSeed);
      const creates =
        movementOps.length > 0
          ? movementOps
          : [openingOperation(holding, assetId, today, fundSeed)];
      const defaults = defaultsFor(instrument);
      funds.push({
        asset: {
          currency: "EUR",
          id: assetId,
          instrument,
          liquidityTier: defaults.rung,
          name: holding.name,
          ownership,
          ...(holding.isin ? { isin: holding.isin } : {}),
        },
        creates,
        kind: "new",
      });
      continue;
    }

    if (entry.decision === "update") {
      const assetId = entry.target;
      // Re-resolve the curated target against LIVE data, not the draft: it must be a
      // candidate the FRESH matcher surfaced for THIS row (so a client cannot target
      // an unrelated or connected-source holding — its id is not a candidate) AND a
      // manual investment asset (excludes liabilities and sync-owned holdings). A
      // target that no longer qualifies is a validity failure: skip it, never write
      // to a vanished or wrong holding.
      const candidates = rowById.get(entry.rowId)?.match.candidates ?? [];
      const isLiveCandidate = candidates.some(
        (candidate) => candidate.holdingId === assetId,
      );
      if (!assetId || !isLiveCandidate || !investmentAssetIds.has(assetId)) continue;
      const creates = operationsFromMovements(document, holding, assetId, fundSeed);
      if (creates.length === 0) continue; // value-only update: nothing to append.
      funds.push({ assetId, creates, deletes: [], kind: "matched", overwrites: [] });
    }
  }
  return funds;
}

/** The persisted reconcile document as the extractor's `positions_movements` shape. */
function asExtractedDocument(
  document: ReconcileDocument,
): ExtractedPositionsMovementsDocument {
  return {
    documentType: "positions_movements",
    holdings: document.holdings,
    movements: document.movements,
    warnings: [],
  };
}

export async function confirmReconcileProposalAction(
  rawDraft: unknown,
  rawCuration: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  const _store = testStoreFromActionArgs(_testArgs);
  const clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  const blocked = await guardWrites();
  if (blocked) return blocked;
  const draft = parseReconcileProposalDraft(rawDraft);
  if (!draft) return { message: "Propuesta no reconocida.", status: "error" };
  const curation = parseReconcileCuration(rawCuration);
  if (!curation)
    return { message: "La selección del reconcile no es válida.", status: "error" };

  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(draft.proposalId);
    if (!proposal || proposal.kind !== "reconcile" || proposal.status !== "draft") {
      return { message: "La propuesta ya no está disponible.", status: "error" };
    }
    const document = reconcileDocumentOf(proposal);
    if (!document) {
      return {
        message: "La propuesta no contiene un documento de cartera.",
        status: "error",
      };
    }
    const workspace = await store.workspace.readWorkspace();
    if (!workspace) return { message: "Workspace no inicializado.", status: "error" };

    // Fence off sync-owned holdings from the write scope (the "no escribas a fuente
    // conectada" boundary, enforced in code) and re-run the matcher against the LIVE
    // portfolio so the curated targets are re-resolved against current data.
    const connectedIds = await connectedReconcileAssetIds(store.connectedSources);
    const investmentAssetIds = new Set(
      (await store.assets.readInvestmentAssetsWithMeta())
        .map((meta) => meta.id)
        .filter((id) => !connectedIds.has(id)),
    );
    const portfolio = await projectReconcilePortfolio(store);
    const freshRows = buildReconcileRows(asExtractedDocument(document), portfolio);
    const rowById = new Map(freshRows.map((row) => [row.rowId, row]));
    const ownership = resolveOwnershipSplit({
      activeMembers: workspace.members.filter((member) => !member.disabledAt),
      preset: "scope",
      shortfall: "complete-to-full-ownership",
    });
    const today = clock.today();
    const funds = resolveFunds(
      document,
      curation,
      rowById,
      investmentAssetIds,
      ownership,
      today,
      Date.now(),
    );
    if (funds.length === 0) {
      return { message: "No hay cambios que aplicar en el reconcile.", status: "error" };
    }

    await store.command.applyAssistantReconcileProposal({
      funds,
      proposalId: proposal.id,
      today,
    });
    const created = funds.filter((fund) => fund.kind === "new").length;
    return { created, status: "applied", updated: funds.length - created };
  }, _store);
}

export async function discardReconcileProposalAction(
  rawDraft: unknown,
  ..._testArgs: unknown[]
): Promise<ActionResult> {
  const _store = testStoreFromActionArgs(_testArgs);
  const blocked = await guardWrites();
  if (blocked) return blocked;
  const draft = parseReconcileProposalDraft(rawDraft);
  if (!draft) return { message: "Propuesta no reconocida.", status: "error" };
  return runActionWithStore(async (store) => {
    const proposal = await store.assistantProposals.read(draft.proposalId);
    if (!proposal || proposal.kind !== "reconcile" || proposal.status !== "draft") {
      return { message: "La propuesta ya no está disponible.", status: "error" };
    }
    await store.assistantProposals.markDiscarded(proposal.id);
    return { status: "discarded" };
  }, _store);
}
