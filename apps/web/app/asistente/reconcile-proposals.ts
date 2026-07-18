/**
 * Reconcile proposal builder (#1108, PRD #1103 S5) — the culmination. Turns an S4
 * `positions_movements` extraction into a persisted `reconcile` assistant proposal:
 * it validates the untrusted document at the trust boundary, joins it to the current
 * portfolio through the S1 matcher, and returns an editable per-row preview with the
 * net-worth impact header (superficie B, #1088). It writes NOTHING to the portfolio;
 * the app applies the user-curated batch on confirm, atomically all-or-nothing.
 *
 * Security (prompt-injection): the document reaches here as raw model/extractor
 * output and is re-validated by the branded contract schema before any use — the
 * same #865 invariant S4 upholds. Only the schema-bounded holding/movement names
 * survive, and they reach chat framed as data (JSON), never as instructions.
 */

import { createHash } from "node:crypto";
import type {
  AgentViewReadStore,
  AssistantProposalStore,
  ReconcileDocument,
  WorthlineStore,
} from "@worthline/db";
import type { MatchPortfolioHolding } from "@worthline/domain";

import {
  type ExtractedPositionsMovementsDocument,
  positionsMovementsDocumentSchema,
} from "./attachment-extraction-contract";
import { readScopeNetWorthBeforeMinor } from "./proposal-net-worth";
import { buildReconcileRows, reconcileSummary } from "./reconcile-plan";
import type { ReconcileProposal } from "./reconcile-proposal-contract";

/** The connected-source reads the reconcile needs to fence off sync-owned holdings. */
type ConnectedSourceReads = Pick<
  WorthlineStore["connectedSources"],
  "listSources" | "listSourceAssetIds"
>;

type ReconcileProposalStore = Pick<
  WorthlineStore,
  "assets" | "liabilities" | "workspace"
> & {
  assistantProposals: AssistantProposalStore;
  agentView: AgentViewReadStore;
  /** Optional so the narrow chat-tool store still satisfies the builder in tests. */
  connectedSources?: ConnectedSourceReads;
};

export type ReconcileProposalBuildResult =
  | { ok: true; proposal: ReconcileProposal }
  | { ok: false; error: string };

/**
 * Every asset id owned by a connected source (Binance, Numista…). The reconcile
 * never writes to these — the sync is the owner (#1048/#1082) — so they are fenced
 * out of the matcher candidates and can never be offered nor confirmed as an
 * `update` target. Empty when the store exposes no connected-source reads.
 */
export async function connectedReconcileAssetIds(
  connectedSources: ConnectedSourceReads | undefined,
): Promise<Set<string>> {
  if (!connectedSources) return new Set();
  const sources = await connectedSources.listSources();
  const perSource = await Promise.all(
    sources.map((source) => connectedSources.listSourceAssetIds(source.id)),
  );
  return new Set(perSource.flat());
}

/**
 * Project the current portfolio into matcher holdings (assets + liabilities),
 * excluding connected-source-owned assets so a sync-owned holding is never a match
 * candidate — the code-level enforcement of the "no escribas a fuente conectada"
 * boundary (not left to model discretion).
 */
export async function projectReconcilePortfolio(
  store: ReconcileProposalStore,
): Promise<MatchPortfolioHolding[]> {
  const connectedIds = await connectedReconcileAssetIds(store.connectedSources);
  const assets = await store.assets.readAssets();
  const investmentMeta = await store.assets.readInvestmentAssetsWithMeta();
  const metaById = new Map(investmentMeta.map((meta) => [meta.id, meta]));
  const assetHoldings: MatchPortfolioHolding[] = assets
    .filter((asset) => !connectedIds.has(asset.id))
    .map((asset) => {
      const meta = metaById.get(asset.id);
      return {
        holdingId: asset.id,
        name: asset.name,
        ...(asset.instrument ? { instrument: asset.instrument } : {}),
        ...(meta?.isin ? { isin: meta.isin } : {}),
        ...((asset.providerSymbol ?? meta?.providerSymbol)
          ? { providerSymbol: asset.providerSymbol ?? meta?.providerSymbol ?? null }
          : {}),
      };
    });
  const liabilities = await store.liabilities.readLiabilities();
  const liabilityHoldings: MatchPortfolioHolding[] = liabilities.map((liability) => ({
    holdingId: liability.id,
    name: liability.name,
  }));
  return [...assetHoldings, ...liabilityHoldings];
}

/** The persisted (holdings + movements) view of an extracted document. */
function toReconcileDocument(
  document: ExtractedPositionsMovementsDocument,
): ReconcileDocument {
  return {
    holdings: document.holdings.map((holding) => ({
      name: holding.name,
      type: holding.type,
      value: holding.value,
      currency: holding.currency,
      fidelity: holding.fidelity,
      ...(holding.isin ? { isin: holding.isin } : {}),
      ...(holding.declaredCost !== undefined
        ? { declaredCost: holding.declaredCost }
        : {}),
      ...(holding.uncertain ? { uncertain: true } : {}),
    })),
    movements: document.movements.map((movement) => ({
      date: movement.date,
      kind: movement.kind,
      amount: movement.amount,
      currency: movement.currency,
      ...(movement.isin ? { isin: movement.isin } : {}),
      ...(movement.name ? { name: movement.name } : {}),
      ...(movement.units !== undefined ? { units: movement.units } : {}),
      ...(movement.uncertain ? { uncertain: true } : {}),
    })),
  };
}

export async function buildReconcileProposal(
  store: ReconcileProposalStore,
  rawDocument: unknown,
  today: string,
  documentName = "cartera.xlsx",
): Promise<ReconcileProposalBuildResult> {
  const parsed = positionsMovementsDocumentSchema.safeParse(rawDocument);
  if (!parsed.success) {
    return { ok: false, error: "El documento de cartera no es válido." };
  }
  const document = parsed.data;

  const workspace = await store.workspace.readWorkspace();
  if (!workspace) return { ok: false, error: "Workspace no inicializado." };

  const portfolio = await projectReconcilePortfolio(store);
  const rows = buildReconcileRows(document, portfolio);
  const summary = reconcileSummary(rows);
  if (summary.active === 0) {
    return {
      ok: false,
      error:
        "El documento no aporta ningún holding que crear ni movimientos que añadir a la cartera.",
    };
  }

  const netWorthBeforeMinor = await readScopeNetWorthBeforeMinor(store.agentView, today);

  const persistedDocument = toReconcileDocument(document);
  const proposal = await store.assistantProposals.create({ kind: "reconcile" });
  await store.assistantProposals.appendDocument(proposal.id, {
    document: {
      name: documentName.trim().slice(0, 255) || "cartera.xlsx",
      provenance: "agent",
      sha256: createHash("sha256")
        .update(JSON.stringify(persistedDocument))
        .digest("hex"),
    },
    facts: [{ kind: "holding_reconcile", row: persistedDocument }],
  });

  return {
    ok: true,
    proposal: {
      draft: { proposalId: proposal.id },
      netWorthBeforeMinor,
      proposalType: "reconcile",
      rows,
    },
  };
}
