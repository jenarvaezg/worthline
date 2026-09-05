import { randomUUID } from "node:crypto";
import type {
  AssetPrice,
  ExportedAmortizationPlan,
  ExportedAsset,
  ExportedBalanceAnchor,
  ExportedBalanceRebaseline,
  ExportedConnectedSource,
  ExportedLiability,
  ExportedPosition,
  ExportedPublicId,
  ExportedSnapshot,
  ExportedValuationAnchor,
  FireScopeConfig,
  SnapshotHoldingRow,
  SnapshotPositionRow,
  Workspace,
  WorkspaceExport,
} from "@worthline/domain";
import {
  asDateKey,
  asInstant,
  assertSnapshotHoldingsReconcile,
  defaultInstrumentForAssetType,
  defaultInstrumentForLiability,
  instrumentOfAsset,
  preservedSecurityId,
  serializeWorkspaceExport,
  valuationMethodOfAsset,
  valuationMethodOfLiability,
} from "@worthline/domain";
import { asc, eq, sql } from "drizzle-orm";
import {
  ensureAgentViewPublicIds,
  publicIdTargetsForHolding,
  publicIdTargetsForWorkspace,
  readAgentViewPublicIds,
} from "./agent-view-public-ids";
import { classifiableAssetFromRow } from "./asset-classification";
import { groupContributionLotsByAsset } from "./asset-reads";
import { mapPositionRow, positionInsertValues } from "./connected-source-store";
import { managedPortfolioWitnessOfRow } from "./managed-portfolio-store";
import {
  operationCaptureColumns,
  operationCostBasisColumns,
  operationTransferColumns,
  toOperation,
} from "./operation-reads";
import { readAssetOwnerships, readLiabilityOwnerships } from "./ownership-reads";
import {
  agentViewPublicIds,
  amortizationPlans,
  appSettings,
  assetOperations,
  assetOwnerships,
  assetPriceCache,
  assets,
  assetValuations,
  connectedSources,
  contributionAllowanceHoldings,
  contributionAllowances,
  contributionLots,
  contributionOccurrenceOperations,
  contributionOccurrenceReconciliations,
  earlyRepayments,
  interestRateRevisions,
  investmentAssets,
  liabilities,
  liabilityBalanceAnchors,
  liabilityBalanceRebaselines,
  liabilityOwnerships,
  managedPortfolioHoldings,
  managedPortfolios,
  memberGroupMembers,
  memberGroups,
  members,
  payoutSchedules,
  payouts,
  plannedContributions,
  positions,
  snapshotHoldings,
  snapshotPositionHoldings,
  snapshots,
  warningOverrides,
  workspace as workspaceTable,
} from "./schema";
import { readSnapshots } from "./snapshot-store";
import type { StoreContext, StoreDb } from "./store-context";
import { wipeWorkspaceTables } from "./workspace-tables";

/**
 * Outcome of {@link WorkspaceDocumentStore.importWorkspace}. The import itself
 * always committed (or threw); this reports the best-effort post-import
 * historical-snapshot gap-fill (ADR 0012, #112). When it failed, `gapFillError`
 * carries the cause so the UI can surface it and prompt a re-run of the backfill
 * — rather than the failure being swallowed by a bare `console.error` (#185).
 */
export interface ImportWorkspaceResult {
  /** The post-import gap-fill error, when it failed; absent on success. */
  gapFillError?: Error;
}

/**
 * Cross-domain orchestration the document store composes but does not own.
 * importWorkspace must gap-fill historical snapshots after the bulk insert
 * (ADR 0012, #112); that reconstruction lives outside this store (it spans every
 * domain and the snapshot save path), so it is injected rather than imported —
 * exactly mirroring how the monolith already composed it at the call site.
 */
export interface WorkspaceDocumentDeps {
  /** Run the post-import historical-snapshot gap-fill against the live workspace. */
  gapFillHistoricalSnapshots: (workspace: Workspace, today: string) => Promise<void>;
}

/**
 * The whole-workspace document paths (ADR 0010): serialize the workspace out and
 * replace it wholesale from a file. The workspace lifecycle is the other half,
 * in `workspace-store.ts`; `WorkspaceStore` in `store-types.ts` joins them.
 *
 * NOTE: importWorkspace duplicates the snapshot + holding INSERT shape that
 * saveSnapshot also runs. The duplication is deliberate (import does a raw
 * bulk insert with ids preserved and never the snapshot upsert path); a later
 * slice owns any deduplication.
 */
export interface WorkspaceDocumentStore {
  /**
   * Serialize the entire workspace into the versioned export document
   * (ADR 0010): live state, snapshot history, the papelera, and the price
   * cache. Read-only — exporting never writes. The audit log is not a section.
   * Throws when no workspace has been initialized.
   */
  exportWorkspace: () => Promise<WorkspaceExport>;
  /**
   * Atomically replace the entire workspace with an already-validated export
   * document (ADR 0010, #103): every table is emptied and the file's sections
   * are bulk-inserted with their ids preserved. Callers must validate the
   * document with parseWorkspaceExport first — this method does not re-parse.
   */
  importWorkspace: (doc: WorkspaceExport) => Promise<ImportWorkspaceResult>;
}

export function createWorkspaceDocumentStore(
  ctx: StoreContext,
  deps: WorkspaceDocumentDeps,
): WorkspaceDocumentStore {
  return {
    exportWorkspace: async () => buildWorkspaceExport(ctx.db, await ctx.getWorkspace()),
    importWorkspace: (doc) => importWorkspace(ctx, deps, doc),
  };
}

async function importWorkspace(
  ctx: StoreContext,
  deps: WorkspaceDocumentDeps,
  doc: WorkspaceExport,
): Promise<ImportWorkspaceResult> {
  const { db } = ctx;

  await ctx.transaction(async () => {
    // Full replace (ADR 0010): the same wipe resetWorkspace runs, shared so the
    // two full-replace paths cannot drift. Then the file's sections are bulk-
    // inserted with their ids preserved via Drizzle — raw values on purpose,
    // never the domain constructors that mint ids.
    await wipeWorkspaceTables(ctx.client);

    await db
      .insert(workspaceTable)
      .values({
        baseCurrency: doc.workspace.baseCurrency,
        id: "default",
        mode: doc.workspace.mode,
      })
      .run();

    if (doc.members.length > 0) {
      await db
        .insert(members)
        .values(
          doc.members.map((member) => ({
            birthMonth: member.birthMonth ?? null,
            birthYear: member.birthYear ?? null,
            disabledAt: member.disabledAt ?? null,
            fiscalCountry: member.fiscalCountry ?? null,
            id: member.id,
            name: member.name,
            riskTolerance: member.riskTolerance ?? null,
          })),
        )
        .run();
    }

    for (const group of doc.groups) {
      await db.insert(memberGroups).values({ id: group.id, name: group.name }).run();

      if (group.memberIds.length > 0) {
        await db
          .insert(memberGroupMembers)
          .values(
            group.memberIds.map((memberId, sortOrder) => ({
              groupId: group.id,
              memberId,
              sortOrder,
            })),
          )
          .run();
      }
    }

    if (doc.publicIds.length > 0) {
      await db.insert(agentViewPublicIds).values(toPublicIdRows(doc.publicIds)).run();
    }
    await ensureAgentViewPublicIds(ctx, publicIdTargetsForWorkspace(doc));
    // Holding public ids for every imported holding — live AND trashed assets
    // and liabilities (#335). The file's own rows are inserted above; this mints
    // any missing one (a pre-#335 file) so the non-lazy read path never 500s.
    await ensureAgentViewPublicIds(
      ctx,
      [
        ...doc.assets,
        ...doc.trash.assets,
        ...doc.liabilities,
        ...doc.trash.liabilities,
      ].flatMap((holding) => publicIdTargetsForHolding(holding.id)),
    );

    const writeAsset = async (asset: ExportedAsset): Promise<void> => {
      // Derived once and reused for the method below, so the row cannot land with
      // an instrument and a valuation method that disagree (#1680).
      const instrument =
        asset.instrument ??
        defaultInstrumentForAssetType(asset.type, asset.isPrimaryResidence ?? false);

      await db
        .insert(assets)
        .values({
          annualAppreciationRate: asset.annualAppreciationRate ?? null,
          // Restaurada tal cual (#1528, ADR 0100): sin ella el holding volvería a
          // «nadie lo ha dicho» y el reparto lo contaría disponible desde el año uno.
          availableFrom: asset.availableFrom ?? null,
          // The connected-source back-link (ADR 0016/0021, #248), restored verbatim
          // — a plain column, no FK (the source's FK already points the other way).
          connectedSourceId: asset.connectedSourceId ?? null,
          currency: asset.currency,
          // Investments are stored at zero like createInvestmentAsset does:
          // their value is derived from operations and prices on read, never
          // stored (ADR 0006). Hand-valued kinds carry the file's value.
          currentValueMinor:
            asset.type === "investment" ? 0 : (asset.currentValue?.amountMinor ?? 0),
          deletedAt: asset.deletedAt ?? null,
          id: asset.id,
          instrument,
          isPrimaryResidence: asset.isPrimaryResidence ? 1 : 0,
          liquidityTier: asset.liquidityTier,
          name: asset.name,
          trashExit: asset.trashExit ?? null,
          type: asset.type,
          // Normalize to the canonical pair: only `interpolated` is stored, every
          // other value (incl. an explicit "step" or an absent field) is `null` = step.
          valuationCadence:
            asset.valuationCadence === "interpolated" ? "interpolated" : null,
          // The method is DERIVED from the instrument written just above (#1680),
          // never copied from the file. A hand-rolled v1 document must not be able
          // to plant a method that contradicts its own instrument — that is exactly
          // the incoherence the round-trip used to fix instead of cure.
          valuationMethod: valuationMethodOfAsset({
            instrument,
            isPrimaryResidence: asset.isPrimaryResidence ?? false,
            type: asset.type,
          }),
        })
        .run();

      if (asset.ownership.length > 0) {
        await db
          .insert(assetOwnerships)
          .values(
            asset.ownership.map((share) => ({
              assetId: asset.id,
              memberId: share.memberId,
              shareBps: share.shareBps,
            })),
          )
          .run();
      }

      // Housing valuation anchors (ADR 0015, #155) — ids preserved like every
      // other restored row. FK to assets is satisfied: the asset is inserted above.
      if (asset.valuationAnchors && asset.valuationAnchors.length > 0) {
        await db
          .insert(assetValuations)
          .values(
            asset.valuationAnchors.map((anchor) => ({
              adjustsPriorCurve: anchor.adjustsPriorCurve ? 1 : 0,
              assetId: asset.id,
              id: anchor.id,
              valuationDate: anchor.valuationDate,
              valueMinor: anchor.valueMinor,
            })),
          )
          .run();
      }

      // Los lotes de aportación (#1676), restaurados tal cual. Ids nuevos a
      // propósito: un lote no es una entidad que nadie siga entre ediciones —es una
      // línea de una declaración que se reemplaza de una pieza— así que el fichero
      // no los lleva y aquí no hay ninguno que preservar.
      if (asset.contributionLots && asset.contributionLots.length > 0) {
        await db
          .insert(contributionLots)
          .values(
            asset.contributionLots.map((lot) => ({
              amountMinor: lot.amountMinor,
              assetId: asset.id,
              availableFrom: lot.availableFrom,
              id: randomUUID(),
            })),
          )
          .run();
      }

      // Every investment gets its metadata row (all-null when the file
      // carries none) — read paths expect the row to exist. The identifier is
      // written AS THE DOCUMENT SAYS, deliberately skipping the per-kind write
      // guard: a restore preserves, never derives (#1416). `preservedSecurityId`
      // is total — it classifies by shape and keeps verbatim what it cannot name,
      // so a legacy `isin` field holding a DGS code lands typed, and garbage lands
      // with a null kind for data health to claim instead of failing the restore.
      // This is the ONLY write in the codebase that may leave that kind null.
      if (asset.type === "investment") {
        const securityId = preservedSecurityId(
          asset.investment?.securityId ?? asset.investment?.isin,
        );
        await db
          .insert(investmentAssets)
          .values({
            assetId: asset.id,
            securityId: securityId?.value ?? null,
            securityIdKind: securityId?.kind ?? null,
            manualPricePerUnit: asset.investment?.manualPricePerUnit ?? null,
            manualPricedAt: asset.investment?.manualPricedAt ?? null,
            priceProvider: asset.investment?.priceProvider ?? null,
            providerSymbol: asset.investment?.providerSymbol ?? null,
            unitSymbol: asset.investment?.unitSymbol ?? null,
          })
          .run();
      }
    };

    // Trash entries land in the same tables with deleted_at set. All
    // assets go in before liabilities so associated_asset_id can point at
    // a trashed asset without tripping the FK.
    for (const asset of doc.assets) await writeAsset(asset);
    for (const asset of doc.trash.assets) await writeAsset(asset);

    const writeLiability = async (liability: ExportedLiability): Promise<void> => {
      const debtModel = liability.debtModel ?? null;

      await db
        .insert(liabilities)
        .values({
          associatedAssetId: liability.associatedAssetId ?? null,
          currency: liability.currency,
          currentBalanceMinor: liability.currentBalance.amountMinor,
          // The full holding model (ADR 0015, #155): the debt model + method are
          // first-class, derived from the model when the file omits the method.
          debtModel,
          deletedAt: liability.deletedAt ?? null,
          id: liability.id,
          instrument:
            liability.instrument ??
            defaultInstrumentForLiability(liability.type, debtModel),
          name: liability.name,
          type: liability.type,
          // Normalize to the canonical pair: only `interpolated` is stored, every
          // other value (incl. an explicit "step" or an absent field) is `null` = step.
          valuationCadence:
            liability.valuationCadence === "interpolated" ? "interpolated" : null,
          // Derived from the debt model, not read off the file (#1680): the same
          // rule as the asset above — a document cannot declare a method that
          // contradicts the model it also declares.
          valuationMethod: valuationMethodOfLiability(debtModel),
        })
        .run();

      if (liability.ownership.length > 0) {
        await db
          .insert(liabilityOwnerships)
          .values(
            liability.ownership.map((share) => ({
              liabilityId: liability.id,
              memberId: share.memberId,
              shareBps: share.shareBps,
            })),
          )
          .run();
      }

      // Amortization plan + its dated facts (ADR 0015, #155): the plan first
      // (FK to liabilities is satisfied above), then its revisions and early
      // repayments (FK to the plan is satisfied here), all ids preserved.
      const plan = liability.amortizationPlan;
      if (plan) {
        await db
          .insert(amortizationPlans)
          .values({
            annualInterestRate: plan.annualInterestRate,
            disbursementDate: plan.disbursementDate,
            firstPaymentDate: plan.firstPaymentDate,
            id: plan.id,
            initialCapitalMinor: plan.initialCapitalMinor,
            liabilityId: liability.id,
            originalSigningDate: plan.originalSigningDate ?? null,
            termMonths: plan.termMonths,
          })
          .run();

        if (plan.interestRateRevisions.length > 0) {
          await db
            .insert(interestRateRevisions)
            .values(
              plan.interestRateRevisions.map((revision) => ({
                id: revision.id,
                newAnnualInterestRate: revision.newAnnualInterestRate,
                planId: plan.id,
                revisionDate: revision.revisionDate,
              })),
            )
            .run();
        }

        if (plan.earlyRepayments.length > 0) {
          await db
            .insert(earlyRepayments)
            .values(
              plan.earlyRepayments.map((repayment) => ({
                amountMinor: repayment.amountMinor,
                id: repayment.id,
                mode: repayment.mode,
                planId: plan.id,
                repaymentDate: repayment.repaymentDate,
              })),
            )
            .run();
        }
      }

      if (liability.balanceRebaselines && liability.balanceRebaselines.length > 0) {
        await db
          .insert(liabilityBalanceRebaselines)
          .values(
            liability.balanceRebaselines.map((rebaseline) => ({
              annualInterestRate: rebaseline.annualInterestRate,
              baselineDate: rebaseline.baselineDate,
              endDate: rebaseline.endDate,
              id: rebaseline.id,
              inputMode: rebaseline.inputMode,
              liabilityId: liability.id,
              monthlyPaymentMinor: rebaseline.monthlyPaymentMinor,
              nextPaymentDate: rebaseline.nextPaymentDate,
              outstandingBalanceMinor: rebaseline.outstandingBalanceMinor,
              startsAtBaseline: rebaseline.startsAtBaseline,
            })),
          )
          .run();
      }

      // Balance anchors for a revolving/informal debt (ADR 0015, #155).
      if (liability.balanceAnchors && liability.balanceAnchors.length > 0) {
        await db
          .insert(liabilityBalanceAnchors)
          .values(
            liability.balanceAnchors.map((anchor) => ({
              anchorDate: anchor.anchorDate,
              balanceMinor: anchor.balanceMinor,
              id: anchor.id,
              liabilityId: liability.id,
            })),
          )
          .run();
      }
    };

    for (const liability of doc.liabilities) await writeLiability(liability);
    for (const liability of doc.trash.liabilities) await writeLiability(liability);

    if (doc.operations.length > 0) {
      await db
        .insert(assetOperations)
        .values(
          doc.operations.map((operation) => ({
            assetId: operation.assetId,
            ...operationCaptureColumns(operation.capture),
            ...operationCostBasisColumns(operation),
            currency: operation.currency,
            executedAt: asDateKey(operation.executedAt.slice(0, 10)),
            feesMinor: operation.feesMinor,
            id: operation.id,
            kind: operation.kind,
            ...(operation.occurredAt === undefined
              ? {}
              : { occurredAt: asInstant(operation.occurredAt) }),
            pricePerUnit: operation.pricePerUnit,
            source: operation.source ?? "manual",
            ...operationTransferColumns(operation),
            units: operation.units,
          })),
        )
        .run();
    }

    const exportedContributions = doc.contributionPlans.flatMap((plan) =>
      plan.contributions.map((contribution) => ({
        ...contribution,
        scopeId: plan.scopeId,
      })),
    );
    if (exportedContributions.length > 0) {
      await db
        .insert(plannedContributions)
        .values(
          exportedContributions.map((contribution) => ({
            id: contribution.id,
            scopeId: contribution.scopeId,
            destinationHoldingId: contribution.destinationHoldingId,
            amountJson: JSON.stringify(contribution.amount),
            cadenceJson: JSON.stringify(contribution.cadence),
            startDate: contribution.startDate,
            endDate: contribution.endDate ?? null,
          })),
        )
        .run();
    }
    if (doc.contributionReconciliations.length > 0) {
      await db
        .insert(contributionOccurrenceReconciliations)
        .values(
          doc.contributionReconciliations.map((reconciliation) => ({
            occurrenceId: reconciliation.occurrenceId,
            contributionId: reconciliation.contributionId,
            state: reconciliation.state,
            storedExecutionMinor: reconciliation.storedExecutionMinor ?? null,
          })),
        )
        .run();
      const links = doc.contributionReconciliations.flatMap((reconciliation) =>
        reconciliation.operationIds.map((operationId) => ({
          occurrenceId: reconciliation.occurrenceId,
          operationId,
        })),
      );
      if (links.length > 0) {
        await db.insert(contributionOccurrenceOperations).values(links).run();
      }
    }

    // Annual contribution ceilings (ADR 0080), restored by id after their holdings
    // (FK). Only the declaration is in the file: what has been consumed derives
    // from the operations restored above, so nothing is written for it.
    if (doc.contributionAllowances.length > 0) {
      await db
        .insert(contributionAllowances)
        .values(
          doc.contributionAllowances.map((allowance) => ({
            annualCapMinor: allowance.annualCapMinor,
            id: allowance.id,
            label: allowance.label,
            scopeId: allowance.scopeId,
          })),
        )
        .run();
      const allowanceLinks = doc.contributionAllowances.flatMap((allowance) =>
        allowance.holdingIds.map((assetId) => ({
          allowanceId: allowance.id,
          assetId,
        })),
      );
      if (allowanceLinks.length > 0) {
        await db.insert(contributionAllowanceHoldings).values(allowanceLinks).run();
      }
    }

    // Managed portfolios (ADR 0085, #1547), restored by id after their holdings
    // (FK) — the members themselves are ordinary assets restored above, cash
    // sibling included. Only the grouping travels; the value stays derived.
    if (doc.managedPortfolios.length > 0) {
      await db
        .insert(managedPortfolios)
        .values(
          doc.managedPortfolios.map((portfolio) => ({
            declaredCurrency: portfolio.witness?.declaredValue.currency ?? null,
            declaredDate: portfolio.witness?.declaredDate ?? null,
            declaredValueMinor: portfolio.witness?.declaredValue.amountMinor ?? null,
            id: portfolio.id,
            name: portfolio.name,
            provider: portfolio.provider ?? null,
            scopeId: portfolio.scopeId,
          })),
        )
        .run();
      const portfolioLinks = doc.managedPortfolios.flatMap((portfolio) =>
        portfolio.holdingIds.map((assetId) => ({
          assetId,
          portfolioId: portfolio.id,
        })),
      );
      if (portfolioLinks.length > 0) {
        await db.insert(managedPortfolioHoldings).values(portfolioLinks).run();
      }
    }

    if (doc.warningOverrides.length > 0) {
      await db
        .insert(warningOverrides)
        .values(
          doc.warningOverrides.map((override) => ({
            code: override.code,
            entityId: override.entityId,
          })),
        )
        .run();
    }

    // Payouts + schedules (PRD #652, ADR 0054), restored verbatim by id after
    // their holdings (FK). Occurrences are never in the file — they derive on read.
    if (doc.payouts.length > 0) {
      await db
        .insert(payouts)
        .values(
          doc.payouts.map((payout) => ({
            id: payout.id,
            holdingId: payout.holdingId,
            date: payout.dateISO,
            amountMinor: payout.amountMinor,
            note: payout.note ?? null,
          })),
        )
        .run();
    }
    if (doc.payoutSchedules.length > 0) {
      await db
        .insert(payoutSchedules)
        .values(
          doc.payoutSchedules.map((schedule) => ({
            id: schedule.id,
            holdingId: schedule.holdingId,
            label: schedule.label,
            amountMinor: schedule.amountMinor,
            expensesMinor: schedule.expensesMinor ?? null,
            cadence: schedule.cadence,
            startDate: schedule.startISO,
            endDate: schedule.endISO,
            // The lease terms (#1521): null on any document written before v66, which
            // is the same thing as «nadie lo ha dicho» — never a default in disguise.
            leaseRegime: schedule.leaseRegime ?? null,
            rentRevision: schedule.rentRevision ?? null,
            rentRevisionReference: schedule.rentRevisionReference ?? null,
            postMandatoryTermPolicy: schedule.postMandatoryTermPolicy ?? null,
            exclusionsJson: JSON.stringify(schedule.exclusions),
          })),
        )
        .run();
    }

    // The whole fire config record lands in the single app_settings row
    // exactly as saveFireConfig leaves it.
    if (Object.keys(doc.fireConfig).length > 0) {
      await db
        .insert(appSettings)
        .values({
          key: "fire.config",
          updatedAt: new Date().toISOString(),
          value: JSON.stringify(doc.fireConfig),
        })
        .run();
    }

    for (const snapshot of doc.snapshots) {
      // Defence in depth (ADR 0008): the parser already checked this, but
      // a capture whose rows contradict its own figures must never persist.
      if (snapshot.holdings.length > 0) {
        assertSnapshotHoldingsReconcile(snapshot.holdings, {
          debtsMinor: snapshot.debts.amountMinor,
          grossAssetsMinor: snapshot.grossAssets.amountMinor,
        });
      }

      await db
        .insert(snapshots)
        .values({
          capturedAt: asInstant(snapshot.capturedAt),
          currency: snapshot.totalNetWorth.currency,
          dateKey: asDateKey(snapshot.dateKey),
          debtsMinor: snapshot.debts.amountMinor,
          grossAssetsMinor: snapshot.grossAssets.amountMinor,
          housingEquityMinor: snapshot.housingEquity.amountMinor,
          id: snapshot.id,
          isMonthlyClose: snapshot.isMonthlyClose ? 1 : 0,
          liquidNetWorthMinor: snapshot.liquidNetWorth.amountMinor,
          monthKey: snapshot.monthKey,
          scopeId: snapshot.scopeId,
          scopeLabel: snapshot.scopeLabel,
          totalNetWorthMinor: snapshot.totalNetWorth.amountMinor,
          warningsJson: JSON.stringify(snapshot.warnings),
        })
        .run();

      // The file's holding rows carry no row ids — mint fresh ones.
      if (snapshot.holdings.length > 0) {
        await db
          .insert(snapshotHoldings)
          .values(
            snapshot.holdings.map((row) => ({
              holdingId: row.holdingId,
              id: randomUUID(),
              kind: row.kind,
              label: row.label,
              liquidityTier: row.liquidityTier,
              countsAsHousing: row.countsAsHousing ? 1 : 0,
              securesHousing: row.securesHousing ? 1 : 0,
              snapshotId: snapshot.id,
              unitPrice: row.unitPrice ?? null,
              units: row.units ?? null,
              valueMinor: row.valueMinor,
            })),
          )
          .run();
      }

      // Per-position child rows (ADR 0035, PRD #459 S3) beneath any
      // connected-source holding — the second-level drilldown. Keyed by the
      // parent holding's STABLE id + snapshot id (no live FK into holdings, like
      // saveSnapshot), so a restore preserves the breakdown. The parser already
      // checked Σ positions == holding above; absent on a legacy export → nothing
      // inserted. Fresh row ids — the file carries none.
      const positionRows = snapshot.holdings.flatMap((row) =>
        (row.positions ?? []).map((position) => ({
          id: randomUUID(),
          imageUrl: position.imageUrl,
          label: position.label,
          metal: position.metal,
          parentHoldingId: row.holdingId,
          positionKey: position.positionKey,
          snapshotId: snapshot.id,
          valueMinor: position.valueMinor,
        })),
      );
      if (positionRows.length > 0) {
        await db.insert(snapshotPositionHoldings).values(positionRows).run();
      }
    }

    if (doc.priceCache.length > 0) {
      await db
        .insert(assetPriceCache)
        .values(
          doc.priceCache.map((price) => ({
            assetId: price.assetId,
            currency: price.currency,
            fetchedAt: price.fetchedAt,
            freshnessState: price.freshnessState,
            price: price.price,
            priceDate: price.priceDate ?? null,
            source: price.source,
            staleReason: price.staleReason ?? null,
          })),
        )
        .run();
    }

    // Connected sources + their positions (ADR 0016). The asset they project
    // into is already inserted above (FK satisfied). Credentials are NEVER in
    // the file: a restored source gets an empty credentials blob and no token,
    // so it must have its API key re-entered before it can sync again. The
    // section is normalized to [] by the parser; `?? []` also tolerates a
    // hand-rolled v2 file written before the section existed.
    for (const source of doc.connectedSources ?? []) {
      await db
        .insert(connectedSources)
        .values({
          adapter: source.adapter,
          assetId: source.assetId,
          credentialsJson: "{}",
          id: source.id,
          label: source.label,
          lastSyncAt: source.lastSyncAt ?? null,
          tokenJson: null,
        })
        .run();

      if (source.positions.length > 0) {
        // Re-attach each exported position to its source and write the full column
        // set per kind (coin | token) through the shared insert shape (ADR 0021),
        // so a Binance token round-trips its symbol/balance/wallet/price too.
        await db
          .insert(positions)
          .values(
            source.positions.map((position) =>
              // Narrow per kind so the spread reconstructs the discriminated
              // variant (a bare `{ ...union }` collapses to the common core).
              position.kind === "coin"
                ? positionInsertValues({ ...position, sourceId: source.id })
                : positionInsertValues({ ...position, sourceId: source.id }),
            ),
          )
          .run();
      }
    }

    // One audit entry inside the transaction: a failed import leaves no
    // trace, a successful one starts the fresh log with its section counts.
    await ctx.writeAuditEntry("import_workspace", "workspace", "default", {
      assets: doc.assets.length,
      connectedSources: (doc.connectedSources ?? []).length,
      fireScopes: Object.keys(doc.fireConfig).length,
      groups: doc.groups.length,
      liabilities: doc.liabilities.length,
      members: doc.members.length,
      operations: doc.operations.length,
      priceCache: doc.priceCache.length,
      snapshots: doc.snapshots.length,
      trashAssets: doc.trash.assets.length,
      trashLiabilities: doc.trash.liabilities.length,
      warningOverrides: doc.warningOverrides.length,
    });
  });

  ctx.invalidateWorkspace();

  // Gap-fill historical snapshots (ADR 0012, Slice 3 / #112): generate
  // snapshots for imported operation dates that have no snapshot in the
  // file. Imported snapshots are restored intact and never recalculated —
  // they were captured with real contemporaneous data. Runs outside the
  // import transaction so each save owns its own transaction.
  const importedWorkspace = await ctx.getWorkspace();
  if (importedWorkspace) {
    const today = new Date().toISOString().slice(0, 10);
    try {
      await deps.gapFillHistoricalSnapshots(importedWorkspace, today);
    } catch (error) {
      // The import itself already committed (ADR 0010), so we never roll it
      // back. But the gap-fill is no longer swallowed by a bare console.error
      // (#185): its failure is surfaced to the caller so the UI can prompt a
      // re-run of the backfill rather than leaving silent partial history.
      return {
        gapFillError: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  return {};
}

/**
 * Serialize the entire workspace into the versioned export document
 * (ADR 0010). Strictly read-only: every section is read from the tables and
 * the final assembly is delegated to the domain's serializeWorkspaceExport.
 * The audit log is deliberately not a section.
 */
async function buildWorkspaceExport(
  db: StoreDb,
  workspace: Workspace | null,
): Promise<WorkspaceExport> {
  if (!workspace) {
    throw new Error("Workspace must be initialized before exporting.");
  }

  // Assets — live and trashed — with ownership and investment metadata.
  const assetRows = await db
    .select()
    .from(assets)
    .orderBy(asc(assets.createdAt), asc(assets.id))
    .all();
  const ownershipByAsset = await readAssetOwnerships(db);
  const investmentMetaRows = await db.select().from(investmentAssets).all();
  const investmentMetaByAsset = new Map(
    investmentMetaRows.map((row) => [row.assetId, row] as const),
  );
  // Housing valuation anchors grouped by asset (ADR 0015, #155), ordered by
  // date then id so the restored curve matches what the live store reads back.
  const anchorsByAsset = await readValuationAnchorsByAsset(db);
  // Los lotes de aportación por holding (#1676), ordenados por fecha para que el
  // fichero salga siempre igual y un diff entre dos exportaciones diga la verdad.
  const lotRows = await db
    .select({
      amountMinor: contributionLots.amountMinor,
      assetId: contributionLots.assetId,
      availableFrom: contributionLots.availableFrom,
    })
    .from(contributionLots)
    .orderBy(asc(contributionLots.assetId), asc(contributionLots.availableFrom))
    .all();
  const lotsByAsset = groupContributionLotsByAsset(lotRows);

  const toExportedAsset = (row: typeof assets.$inferSelect): ExportedAsset => {
    const meta = investmentMetaByAsset.get(row.id);
    const anchors = anchorsByAsset.get(row.id) ?? [];
    const classifiable = classifiableAssetFromRow(row);

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      currency: row.currency,
      // Investments never carry a hand value — theirs is derived from
      // operations and prices (ADR 0006), so the file omits currentValue.
      ...(row.type === "investment"
        ? {}
        : {
            currentValue: { amountMinor: row.currentValueMinor, currency: row.currency },
          }),
      liquidityTier: row.liquidityTier,
      isPrimaryResidence: row.isPrimaryResidence === 1,
      // Both fields off the SAME classifiable row, mirroring the import's single
      // derivation (#1680): the exported method must be the one the exported
      // instrument implies, or the file re-opens the gap it just closed. Derived
      // from the instrument, never the `valuation_method` column — exporting the
      // column would write a stale method into the file and the import would read
      // it straight back, a round-trip that fixes the error instead of curing it.
      instrument: instrumentOfAsset(classifiable),
      valuationMethod: valuationMethodOfAsset(classifiable),
      // The cadence is only serialized when set away from the default `step`
      // (ADR 0031); an omitted field round-trips as step on import.
      ...(row.valuationCadence === "interpolated"
        ? { valuationCadence: row.valuationCadence }
        : {}),
      // The full holding model (ADR 0015, #155): appreciation rate + anchors.
      ...(row.annualAppreciationRate
        ? { annualAppreciationRate: row.annualAppreciationRate }
        : {}),
      ...(anchors.length > 0 ? { valuationAnchors: anchors } : {}),
      // La fecha de disponibilidad declarada (#1528, ADR 0100): una declaración del
      // dueño, así que viaja verbatim — nada la puede volver a derivar en el destino.
      ...(row.availableFrom ? { availableFrom: row.availableFrom } : {}),
      // La escalera de lotes (#1676), verbatim y por lo mismo: sin ella el plan
      // vuelve a ser un bloque y el reparto pierde el tramo ya rescatable.
      ...(lotsByAsset.has(row.id) ? { contributionLots: lotsByAsset.get(row.id) } : {}),
      // The connected-source back-link (ADR 0016/0021, #248), so a multi-rung
      // source's per-rung assets round-trip their link (the source row names only
      // the primary asset).
      ...(row.connectedSourceId ? { connectedSourceId: row.connectedSourceId } : {}),
      ownership: ownershipByAsset.get(row.id) ?? [],
      ...(row.type === "investment" && meta
        ? {
            investment: {
              ...(meta.unitSymbol ? { unitSymbol: meta.unitSymbol } : {}),
              // El par, y solo el par: el campo legacy `isin` se sigue LEYENDO para
              // siempre, pero ya no se escribe — perpetuar el nombre sería perpetuar
              // la mentira de que un plan de pensiones tiene ISIN (#1743).
              ...(meta.securityId ? { securityId: meta.securityId } : {}),
              ...(meta.securityIdKind ? { securityIdKind: meta.securityIdKind } : {}),
              ...(meta.priceProvider ? { priceProvider: meta.priceProvider } : {}),
              ...(meta.providerSymbol ? { providerSymbol: meta.providerSymbol } : {}),
              ...(meta.manualPricePerUnit
                ? { manualPricePerUnit: meta.manualPricePerUnit }
                : {}),
              ...(meta.manualPricedAt ? { manualPricedAt: meta.manualPricedAt } : {}),
            },
          }
        : {}),
      ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
      // How it left the book (#1549). Travels with the deletion it explains, so a
      // restored backup does not re-raise a signal its owner already answered.
      ...(row.trashExit ? { trashExit: row.trashExit } : {}),
    };
  };

  // Liabilities — live and trashed — with ownership.
  const liabilityRows = await db
    .select()
    .from(liabilities)
    .orderBy(asc(liabilities.createdAt), asc(liabilities.id))
    .all();
  const ownershipByLiability = await readLiabilityOwnerships(db);
  // The full debt model (ADR 0015, #155): amortization plans (each with its
  // rate revisions + early repayments) and balance anchors, grouped by liability.
  const planByLiability = await readAmortizationPlansByLiability(db);
  const rebaselinesByLiability = await readBalanceRebaselinesByLiability(db);
  const balanceAnchorsByLiability = await readBalanceAnchorsByLiability(db);

  const toExportedLiability = (
    row: typeof liabilities.$inferSelect,
  ): ExportedLiability => {
    const plan = planByLiability.get(row.id);
    const balanceRebaselines = rebaselinesByLiability.get(row.id) ?? [];
    const balanceAnchors = balanceAnchorsByLiability.get(row.id) ?? [];

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      currency: row.currency,
      currentBalance: { amountMinor: row.currentBalanceMinor, currency: row.currency },
      instrument:
        row.instrument ?? defaultInstrumentForLiability(row.type, row.debtModel),
      valuationMethod: valuationMethodOfLiability(row.debtModel ?? null),
      // The cadence is only serialized when set away from the default `step`
      // (ADR 0031); an omitted field round-trips as step on import.
      ...(row.valuationCadence === "interpolated"
        ? { valuationCadence: row.valuationCadence }
        : {}),
      ...(row.debtModel ? { debtModel: row.debtModel } : {}),
      ...(plan ? { amortizationPlan: plan } : {}),
      ...(balanceRebaselines.length > 0 ? { balanceRebaselines } : {}),
      ...(balanceAnchors.length > 0 ? { balanceAnchors } : {}),
      ownership: ownershipByLiability.get(row.id) ?? [],
      ...(row.associatedAssetId ? { associatedAssetId: row.associatedAssetId } : {}),
      ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
    };
  };

  // Operations for every investment asset — including trashed ones, so a
  // restore after import keeps their history.
  const operationRows = await db
    .select()
    .from(assetOperations)
    .orderBy(
      asc(assetOperations.executedAt),
      asc(assetOperations.occurredAt),
      asc(assetOperations.id),
    )
    .all();
  const operations = operationRows.map(toOperation);

  const warningOverrideRows = await db
    .select({ code: warningOverrides.code, entityId: warningOverrides.entityId })
    .from(warningOverrides)
    .orderBy(asc(warningOverrides.code), asc(warningOverrides.entityId))
    .all();

  const fireRow = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "fire.config"))
    .get();
  const fireConfig = fireRow
    ? (JSON.parse(fireRow.value) as Record<string, FireScopeConfig>)
    : {};

  // Snapshots across all scopes, each carrying its frozen holding rows.
  const holdingsBySnapshot = await readHoldingRowsBySnapshot(db);
  const snapshotRows = await readSnapshots(db);
  const exportedSnapshots: ExportedSnapshot[] = snapshotRows.map((snapshot) => ({
    ...snapshot,
    holdings: holdingsBySnapshot.get(snapshot.id) ?? [],
  }));

  const priceCacheRows = await db
    .select()
    .from(assetPriceCache)
    .orderBy(asc(assetPriceCache.assetId))
    .all();
  const priceCache: AssetPrice[] = priceCacheRows.map((row) => ({
    assetId: row.assetId,
    currency: row.currency,
    fetchedAt: row.fetchedAt,
    freshnessState: row.freshnessState,
    price: row.price,
    source: row.source,
    ...(row.priceDate ? { priceDate: row.priceDate } : {}),
    ...(row.staleReason ? { staleReason: row.staleReason } : {}),
  }));

  // Connected sources + their positions (ADR 0016). credentials_json and
  // token_json are LOCAL-ONLY and deliberately never read here — a restored
  // source has its API key re-entered before it can sync again.
  const positionsBySource = new Map<string, ExportedPosition[]>();
  for (const row of await db
    .select()
    .from(positions)
    .orderBy(asc(positions.createdAt), asc(positions.id))
    .all()) {
    const { sourceId, ...position } = mapPositionRow(row);
    const list = positionsBySource.get(sourceId) ?? [];
    list.push(position);
    positionsBySource.set(sourceId, list);
  }
  const connectedSourceRows = await db
    .select({
      id: connectedSources.id,
      adapter: connectedSources.adapter,
      label: connectedSources.label,
      assetId: connectedSources.assetId,
      lastSyncAt: connectedSources.lastSyncAt,
    })
    .from(connectedSources)
    .orderBy(asc(connectedSources.createdAt), asc(connectedSources.id))
    .all();
  const exportedConnectedSources: ExportedConnectedSource[] = connectedSourceRows.map(
    (row) => ({
      id: row.id,
      adapter: row.adapter,
      label: row.label,
      assetId: row.assetId,
      ...(row.lastSyncAt ? { lastSyncAt: row.lastSyncAt } : {}),
      positions: positionsBySource.get(row.id) ?? [],
    }),
  );

  // Payouts + schedules (PRD #652, ADR 0054), ordered for a stable diff. Only the
  // declaration is exported; occurrences derive on read and are never stored.
  const payoutRows = await db
    .select()
    .from(payouts)
    .orderBy(asc(payouts.date), asc(payouts.id))
    .all();
  const payoutScheduleRows = await db
    .select()
    .from(payoutSchedules)
    .orderBy(asc(payoutSchedules.holdingId), asc(payoutSchedules.id))
    .all();

  // Annual contribution ceilings (ADR 0080). Only the declaration is exported:
  // what has been consumed derives from the operations already in the document.
  const allowanceRows = await db
    .select()
    .from(contributionAllowances)
    .orderBy(asc(contributionAllowances.scopeId), asc(contributionAllowances.id))
    .all();
  const allowanceHoldingRows = await db
    .select()
    .from(contributionAllowanceHoldings)
    .orderBy(
      asc(contributionAllowanceHoldings.allowanceId),
      asc(contributionAllowanceHoldings.assetId),
    )
    .all();

  const contributionRows = await db
    .select()
    .from(plannedContributions)
    .orderBy(
      asc(plannedContributions.scopeId),
      asc(plannedContributions.startDate),
      asc(plannedContributions.id),
    )
    .all();
  const reconciliationRows = await db
    .select({
      contributionId: contributionOccurrenceReconciliations.contributionId,
      occurrenceId: contributionOccurrenceReconciliations.occurrenceId,
      state: contributionOccurrenceReconciliations.state,
      storedExecutionMinor: contributionOccurrenceReconciliations.storedExecutionMinor,
      operationId: contributionOccurrenceOperations.operationId,
    })
    .from(contributionOccurrenceReconciliations)
    .leftJoin(
      contributionOccurrenceOperations,
      eq(
        contributionOccurrenceOperations.occurrenceId,
        contributionOccurrenceReconciliations.occurrenceId,
      ),
    )
    .orderBy(
      asc(contributionOccurrenceReconciliations.occurrenceId),
      asc(contributionOccurrenceOperations.operationId),
    )
    .all();
  const reconciliationById = new Map<
    string,
    WorkspaceExport["contributionReconciliations"][number]
  >();
  for (const row of reconciliationRows) {
    const current = reconciliationById.get(row.occurrenceId) ?? {
      contributionId: row.contributionId,
      occurrenceId: row.occurrenceId,
      state: row.state,
      operationIds: [],
      ...(row.storedExecutionMinor === null
        ? {}
        : { storedExecutionMinor: row.storedExecutionMinor }),
    };
    if (row.operationId !== null) current.operationIds.push(row.operationId);
    reconciliationById.set(row.occurrenceId, current);
  }
  const contributionsByScope = new Map<
    string,
    WorkspaceExport["contributionPlans"][number]
  >();
  for (const row of contributionRows) {
    const plan = contributionsByScope.get(row.scopeId) ?? {
      scopeId: row.scopeId,
      contributions: [],
    };
    plan.contributions.push({
      id: row.id,
      destinationHoldingId: row.destinationHoldingId,
      amount: JSON.parse(row.amountJson),
      cadence: JSON.parse(row.cadenceJson),
      startDate: row.startDate,
      ...(row.endDate === null ? {} : { endDate: row.endDate }),
    });
    contributionsByScope.set(row.scopeId, plan);
  }

  const allowanceHoldingsById = new Map<string, string[]>();
  for (const row of allowanceHoldingRows) {
    const list = allowanceHoldingsById.get(row.allowanceId) ?? [];
    list.push(row.assetId);
    allowanceHoldingsById.set(row.allowanceId, list);
  }

  // Managed portfolios (ADR 0085). Only the grouping is exported; its members
  // (cash sibling included) travel as the ordinary asset rows above.
  const portfolioRows = await db
    .select()
    .from(managedPortfolios)
    .orderBy(asc(managedPortfolios.scopeId), asc(managedPortfolios.id))
    .all();
  const portfolioHoldingRows = await db
    .select()
    .from(managedPortfolioHoldings)
    .orderBy(
      asc(managedPortfolioHoldings.portfolioId),
      asc(managedPortfolioHoldings.assetId),
    )
    .all();
  const portfolioHoldingsById = new Map<string, string[]>();
  for (const row of portfolioHoldingRows) {
    const list = portfolioHoldingsById.get(row.portfolioId) ?? [];
    list.push(row.assetId);
    portfolioHoldingsById.set(row.portfolioId, list);
  }

  return serializeWorkspaceExport({
    workspace: { baseCurrency: workspace.baseCurrency, mode: workspace.mode },
    members: workspace.members,
    groups: workspace.groups,
    payouts: payoutRows.map((row) => ({
      id: row.id,
      holdingId: row.holdingId,
      dateISO: row.date,
      amountMinor: row.amountMinor,
      ...(row.note != null ? { note: row.note } : {}),
    })),
    payoutSchedules: payoutScheduleRows.map((row) => ({
      id: row.id,
      holdingId: row.holdingId,
      label: row.label,
      amountMinor: row.amountMinor,
      expensesMinor: row.expensesMinor,
      cadence: row.cadence,
      startISO: row.startDate,
      endISO: row.endDate,
      leaseRegime: row.leaseRegime,
      rentRevision: row.rentRevision,
      rentRevisionReference: row.rentRevisionReference,
      postMandatoryTermPolicy: row.postMandatoryTermPolicy,
      exclusions: JSON.parse(row.exclusionsJson) as string[],
    })),
    contributionPlans: [...contributionsByScope.values()],
    contributionReconciliations: [...reconciliationById.values()],
    contributionAllowances: allowanceRows.map((row) => ({
      annualCapMinor: row.annualCapMinor,
      holdingIds: allowanceHoldingsById.get(row.id) ?? [],
      id: row.id,
      label: row.label,
      scopeId: row.scopeId,
    })),
    managedPortfolios: portfolioRows.map((row) => ({
      holdingIds: portfolioHoldingsById.get(row.id) ?? [],
      id: row.id,
      name: row.name,
      provider: row.provider ?? null,
      scopeId: row.scopeId,
      // The declared balance (#1550): typed data, so it travels. The
      // all-or-nothing rule is the store's, read through its own mapper.
      witness: managedPortfolioWitnessOfRow(row),
    })),
    assets: assetRows.filter((row) => row.deletedAt === null).map(toExportedAsset),
    liabilities: liabilityRows
      .filter((row) => row.deletedAt === null)
      .map(toExportedLiability),
    operations,
    warningOverrides: warningOverrideRows.map((row) => ({
      code: row.code,
      entityId: row.entityId,
    })),
    fireConfig,
    snapshots: exportedSnapshots,
    trash: {
      assets: assetRows.filter((row) => row.deletedAt !== null).map(toExportedAsset),
      liabilities: liabilityRows
        .filter((row) => row.deletedAt !== null)
        .map(toExportedLiability),
    },
    priceCache,
    connectedSources: exportedConnectedSources,
    // Every holding id present in the DB (live + trashed) — assets and
    // liabilities — so the export carries their holding public ids and filters
    // out any stale registry row (#335).
    publicIds: await currentAgentViewPublicIds(
      db,
      workspace,
      assetRows.map((row) => row.id),
      liabilityRows.map((row) => row.id),
      portfolioRows.map((row) => row.id),
    ),
  });
}

async function currentAgentViewPublicIds(
  db: StoreDb,
  workspace: Workspace,
  holdingIds: string[],
  liabilityIds: string[],
  portfolioIds: string[] = [],
): Promise<ExportedPublicId[]> {
  const liveTargets = new Set(
    [
      ...publicIdTargetsForWorkspace(workspace),
      ...[...holdingIds, ...liabilityIds].flatMap((id) => publicIdTargetsForHolding(id)),
      ...portfolioIds.map((id) => ({
        entityId: id,
        entityType: "managed_portfolio" as const,
      })),
    ].map((target) => `${target.entityType}:${target.entityId}`),
  );

  const rows = await readAgentViewPublicIds(db);
  return rows.filter((row) => liveTargets.has(`${row.entityType}:${row.entityId}`));
}

function toPublicIdRows(
  publicIds: ExportedPublicId[],
): Array<typeof agentViewPublicIds.$inferInsert> {
  return publicIds.map((publicId) => ({
    entityId: publicId.entityId,
    entityType: publicId.entityType,
    publicId: publicId.publicId,
  }));
}

/**
 * Housing valuation anchors grouped by asset (ADR 0015, #155), ordered by date
 * then id — the same order asset-store's readValuationAnchors returns, so the
 * exported curve reconstructs identically on restore.
 */
async function readValuationAnchorsByAsset(
  db: StoreDb,
): Promise<Map<string, ExportedValuationAnchor[]>> {
  const rows = await db
    .select()
    .from(assetValuations)
    .orderBy(asc(assetValuations.valuationDate), asc(assetValuations.id))
    .all();

  const byAsset = new Map<string, ExportedValuationAnchor[]>();

  for (const row of rows) {
    const anchor: ExportedValuationAnchor = {
      id: row.id,
      valueMinor: row.valueMinor,
      valuationDate: row.valuationDate,
      adjustsPriorCurve: row.adjustsPriorCurve === 1,
    };
    const existing = byAsset.get(row.assetId);

    if (existing) {
      existing.push(anchor);
    } else {
      byAsset.set(row.assetId, [anchor]);
    }
  }

  return byAsset;
}

/**
 * The amortization plan of each amortizable liability (ADR 0015, #155), each
 * carrying its rate revisions and early repayments, all ordered by date then id
 * to match the live store readers. The plan is 1:1 with its liability.
 */
async function readAmortizationPlansByLiability(
  db: StoreDb,
): Promise<Map<string, ExportedAmortizationPlan>> {
  const planRows = await db.select().from(amortizationPlans).all();

  const revisionRows = await db
    .select()
    .from(interestRateRevisions)
    .orderBy(asc(interestRateRevisions.revisionDate), asc(interestRateRevisions.id))
    .all();
  const repaymentRows = await db
    .select()
    .from(earlyRepayments)
    .orderBy(asc(earlyRepayments.repaymentDate), asc(earlyRepayments.id))
    .all();

  const revisionsByPlan = new Map<
    string,
    ExportedAmortizationPlan["interestRateRevisions"]
  >();
  for (const row of revisionRows) {
    const revision = {
      id: row.id,
      revisionDate: row.revisionDate,
      newAnnualInterestRate: row.newAnnualInterestRate,
    };
    const existing = revisionsByPlan.get(row.planId);
    if (existing) existing.push(revision);
    else revisionsByPlan.set(row.planId, [revision]);
  }

  const repaymentsByPlan = new Map<string, ExportedAmortizationPlan["earlyRepayments"]>();
  for (const row of repaymentRows) {
    const repayment = {
      id: row.id,
      repaymentDate: row.repaymentDate,
      amountMinor: row.amountMinor,
      mode: row.mode,
    };
    const existing = repaymentsByPlan.get(row.planId);
    if (existing) existing.push(repayment);
    else repaymentsByPlan.set(row.planId, [repayment]);
  }

  const byLiability = new Map<string, ExportedAmortizationPlan>();
  for (const row of planRows) {
    byLiability.set(row.liabilityId, {
      id: row.id,
      initialCapitalMinor: row.initialCapitalMinor,
      annualInterestRate: row.annualInterestRate,
      termMonths: row.termMonths,
      disbursementDate: row.disbursementDate,
      firstPaymentDate: row.firstPaymentDate,
      ...(row.originalSigningDate
        ? { originalSigningDate: row.originalSigningDate }
        : {}),
      interestRateRevisions: revisionsByPlan.get(row.id) ?? [],
      earlyRepayments: repaymentsByPlan.get(row.id) ?? [],
    });
  }

  return byLiability;
}

/**
 * Current-state balance re-baselines grouped by liability (ADR 0056, #676),
 * ordered by baseline date then id so the exported forward schedule is stable.
 */
async function readBalanceRebaselinesByLiability(
  db: StoreDb,
): Promise<Map<string, ExportedBalanceRebaseline[]>> {
  const rows = await db
    .select()
    .from(liabilityBalanceRebaselines)
    .orderBy(
      asc(liabilityBalanceRebaselines.baselineDate),
      asc(liabilityBalanceRebaselines.id),
    )
    .all();

  const byLiability = new Map<string, ExportedBalanceRebaseline[]>();

  for (const row of rows) {
    const rebaseline: ExportedBalanceRebaseline = {
      annualInterestRate: row.annualInterestRate,
      baselineDate: row.baselineDate,
      endDate: row.endDate,
      id: row.id,
      inputMode: row.inputMode,
      monthlyPaymentMinor: row.monthlyPaymentMinor,
      nextPaymentDate: row.nextPaymentDate,
      outstandingBalanceMinor: row.outstandingBalanceMinor,
      startsAtBaseline: row.startsAtBaseline,
    };
    const existing = byLiability.get(row.liabilityId);

    if (existing) {
      existing.push(rebaseline);
    } else {
      byLiability.set(row.liabilityId, [rebaseline]);
    }
  }

  return byLiability;
}

/**
 * Balance anchors grouped by liability (ADR 0015, #155), ordered by date then id
 * — the same order liability-balance-anchor-store's readBalanceAnchors returns.
 */
async function readBalanceAnchorsByLiability(
  db: StoreDb,
): Promise<Map<string, ExportedBalanceAnchor[]>> {
  const rows = await db
    .select()
    .from(liabilityBalanceAnchors)
    .orderBy(asc(liabilityBalanceAnchors.anchorDate), asc(liabilityBalanceAnchors.id))
    .all();

  const byLiability = new Map<string, ExportedBalanceAnchor[]>();

  for (const row of rows) {
    const anchor: ExportedBalanceAnchor = {
      id: row.id,
      balanceMinor: row.balanceMinor,
      anchorDate: row.anchorDate,
    };
    const existing = byLiability.get(row.liabilityId);

    if (existing) {
      existing.push(anchor);
    } else {
      byLiability.set(row.liabilityId, [anchor]);
    }
  }

  return byLiability;
}

/**
 * Every frozen holding row grouped by its owning snapshot, in insertion
 * (rowid) order — the deterministic order the rows were captured in. SQLite's
 * implicit rowid has no schema column, so the ORDER BY drops to a raw `sql`
 * fragment inside the otherwise-Drizzle query.
 */
async function readHoldingRowsBySnapshot(
  db: StoreDb,
): Promise<Map<string, SnapshotHoldingRow[]>> {
  const rows = await db
    .select({
      snapshotId: snapshotHoldings.snapshotId,
      holdingId: snapshotHoldings.holdingId,
      kind: snapshotHoldings.kind,
      label: snapshotHoldings.label,
      liquidityTier: snapshotHoldings.liquidityTier,
      securesHousing: snapshotHoldings.securesHousing,
      countsAsHousing: snapshotHoldings.countsAsHousing,
      valueMinor: snapshotHoldings.valueMinor,
      units: snapshotHoldings.units,
      unitPrice: snapshotHoldings.unitPrice,
    })
    .from(snapshotHoldings)
    .orderBy(sql`rowid ASC`)
    .all();

  // Per-position child rows (ADR 0035, PRD #459 S3), grouped by their parent
  // holding within a snapshot. Read in capture (rowid) order so the exported
  // breakdown is stable; attached below only to the holdings that froze one.
  const positionRows = await db
    .select({
      snapshotId: snapshotPositionHoldings.snapshotId,
      parentHoldingId: snapshotPositionHoldings.parentHoldingId,
      positionKey: snapshotPositionHoldings.positionKey,
      label: snapshotPositionHoldings.label,
      valueMinor: snapshotPositionHoldings.valueMinor,
      metal: snapshotPositionHoldings.metal,
      imageUrl: snapshotPositionHoldings.imageUrl,
    })
    .from(snapshotPositionHoldings)
    .orderBy(sql`rowid ASC`)
    .all();

  const positionsByHolding = new Map<string, SnapshotPositionRow[]>();
  for (const row of positionRows) {
    const key = `${row.snapshotId}::${row.parentHoldingId}`;
    const position: SnapshotPositionRow = {
      positionKey: row.positionKey,
      label: row.label,
      valueMinor: row.valueMinor,
      metal: row.metal,
      imageUrl: row.imageUrl,
    };
    const existing = positionsByHolding.get(key);
    if (existing) existing.push(position);
    else positionsByHolding.set(key, [position]);
  }

  const bySnapshot = new Map<string, SnapshotHoldingRow[]>();

  for (const row of rows) {
    const positions = positionsByHolding.get(`${row.snapshotId}::${row.holdingId}`);
    const holding: SnapshotHoldingRow = {
      holdingId: row.holdingId,
      kind: row.kind,
      label: row.label,
      liquidityTier: row.liquidityTier,
      securesHousing: row.securesHousing === 1,
      countsAsHousing: row.countsAsHousing === 1,
      valueMinor: row.valueMinor,
      ...(row.units !== null ? { units: row.units } : {}),
      ...(row.unitPrice !== null ? { unitPrice: row.unitPrice } : {}),
      ...(positions ? { positions } : {}),
    };
    const existing = bySnapshot.get(row.snapshotId);

    if (existing) {
      existing.push(holding);
    } else {
      bySnapshot.set(row.snapshotId, [holding]);
    }
  }

  return bySnapshot;
}
