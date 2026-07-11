import type {
  ContributionCadence,
  ContributionOccurrenceReconciliation,
  ContributionOccurrenceState,
  ContributionPlan,
  PlannedContribution,
  PlannedContributionAmount,
} from "@worthline/domain";
import {
  assertContributionCadence,
  assertPlannedContributionInput,
  defaultValuationMethodForAssetType,
  expandPlannedContribution,
  parsePlannedContributionAmount,
} from "@worthline/domain";
import { and, asc, eq, sql } from "drizzle-orm";

import {
  assetOperations,
  assets,
  contributionOccurrenceOperations,
  contributionOccurrenceReconciliations,
  plannedContributions,
} from "./schema";
import type { StoreContext } from "./store-context";

/**
 * Contribution-plan persistence (ADR 0041, PRD #553 S1). Stores a scope's planned
 * contributions as forecast metadata only — occurrences are derived on read and
 * reconciliation rows belong in S2.
 */

export interface CreatePlannedContributionInput {
  scopeId: string;
  destinationHoldingId: string;
  amount: PlannedContributionAmount;
  cadence: ContributionCadence;
  startDate: string;
  endDate?: string;
}

export interface UpdatePlannedContributionPatch {
  destinationHoldingId?: string;
  amount?: PlannedContributionAmount;
  cadence?: ContributionCadence;
  startDate?: string;
  endDate?: string | null;
}

export interface ContributionPlanStore {
  readContributionPlan: (scopeId: string) => Promise<ContributionPlan>;
  createPlannedContribution: (
    input: CreatePlannedContributionInput,
  ) => Promise<PlannedContribution>;
  updatePlannedContribution: (
    id: string,
    patch: UpdatePlannedContributionPatch,
  ) => Promise<void>;
  deletePlannedContribution: (id: string) => Promise<void>;
  readReconciliations: (
    scopeId: string,
  ) => Promise<ContributionOccurrenceReconciliation[]>;
  setOccurrenceState: (input: SetOccurrenceStateInput) => Promise<void>;
  linkOperation: (input: LinkContributionOperationInput) => Promise<void>;
  assertStoredDestination: (contributionId: string, assetId: string) => Promise<void>;
}

export interface SetOccurrenceStateInput {
  contributionId: string;
  occurrenceId: string;
  state: ContributionOccurrenceState;
  storedExecutionMinor?: number;
}

export interface LinkContributionOperationInput {
  contributionId: string;
  occurrenceId: string;
  operationId: string;
}

export function createContributionPlanStore(ctx: StoreContext): ContributionPlanStore {
  return {
    readContributionPlan: (scopeId) => readContributionPlan(ctx, scopeId),
    createPlannedContribution: (input) => createPlannedContribution(ctx, input),
    updatePlannedContribution: (id, patch) => updatePlannedContribution(ctx, id, patch),
    deletePlannedContribution: (id) => deletePlannedContribution(ctx, id),
    readReconciliations: (scopeId) => readReconciliations(ctx, scopeId),
    setOccurrenceState: (input) => setOccurrenceState(ctx, input),
    linkOperation: (input) => linkOperation(ctx, input),
    assertStoredDestination: (contributionId, assetId) =>
      assertStoredDestination(ctx, contributionId, assetId),
  };
}

type Row = typeof plannedContributions.$inferSelect;

function parseCadenceJson(raw: string): ContributionCadence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Planned contribution cadence must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
    throw new Error("Planned contribution cadence is invalid.");
  }
  const cadence = parsed as ContributionCadence;
  assertContributionCadence(cadence);
  return cadence;
}

function rowToContribution(row: Row): PlannedContribution {
  let amountRaw: unknown;
  try {
    amountRaw = JSON.parse(row.amountJson);
  } catch {
    throw new Error(`Planned contribution "${row.id}" has invalid amount JSON.`);
  }
  const amount = parsePlannedContributionAmount(amountRaw);
  const cadence = parseCadenceJson(row.cadenceJson);
  assertPlannedContributionInput({
    destinationHoldingId: row.destinationHoldingId,
    amount,
    cadence,
    startDate: row.startDate,
    endDate: row.endDate,
  });
  return {
    id: row.id,
    destinationHoldingId: row.destinationHoldingId,
    amount,
    cadence,
    startDate: row.startDate,
    ...(row.endDate != null ? { endDate: row.endDate } : {}),
  };
}

async function readContributionPlan(
  ctx: StoreContext,
  scopeId: string,
): Promise<ContributionPlan> {
  const rows = await ctx.db
    .select()
    .from(plannedContributions)
    .where(eq(plannedContributions.scopeId, scopeId))
    .orderBy(asc(plannedContributions.startDate), asc(plannedContributions.id))
    .all();

  return {
    scopeId,
    contributions: rows.map(rowToContribution),
  };
}

async function readContributionRow(
  ctx: StoreContext,
  id: string,
): Promise<Row | undefined> {
  return ctx.db
    .select()
    .from(plannedContributions)
    .where(eq(plannedContributions.id, id))
    .get();
}

async function createPlannedContribution(
  ctx: StoreContext,
  input: CreatePlannedContributionInput,
): Promise<PlannedContribution> {
  assertPlannedContributionInput(input);
  const id = ctx.newId();
  const endDate = input.endDate ?? null;
  await ctx.db
    .insert(plannedContributions)
    .values({
      id,
      scopeId: input.scopeId,
      destinationHoldingId: input.destinationHoldingId,
      amountJson: JSON.stringify(input.amount),
      cadenceJson: JSON.stringify(input.cadence),
      startDate: input.startDate,
      endDate,
    })
    .run();

  return {
    id,
    destinationHoldingId: input.destinationHoldingId,
    amount: input.amount,
    cadence: input.cadence,
    startDate: input.startDate,
    ...(endDate != null ? { endDate } : {}),
  };
}

async function updatePlannedContribution(
  ctx: StoreContext,
  id: string,
  patch: UpdatePlannedContributionPatch,
): Promise<void> {
  const existing = await readContributionRow(ctx, id);
  if (!existing) {
    throw new Error(`Planned contribution "${id}" not found.`);
  }

  const current = rowToContribution(existing);
  const next = {
    destinationHoldingId: patch.destinationHoldingId ?? current.destinationHoldingId,
    amount: patch.amount ?? current.amount,
    cadence: patch.cadence ?? current.cadence,
    startDate: patch.startDate ?? current.startDate,
    endDate: patch.endDate === undefined ? current.endDate : (patch.endDate ?? undefined),
  };
  assertPlannedContributionInput({
    ...next,
    endDate: next.endDate ?? null,
  });

  const set: Partial<typeof plannedContributions.$inferInsert> = {};
  if (patch.destinationHoldingId !== undefined) {
    set.destinationHoldingId = patch.destinationHoldingId;
  }
  if (patch.amount !== undefined) {
    set.amountJson = JSON.stringify(patch.amount);
  }
  if (patch.cadence !== undefined) {
    set.cadenceJson = JSON.stringify(patch.cadence);
  }
  if (patch.startDate !== undefined) {
    set.startDate = patch.startDate;
  }
  if (patch.endDate !== undefined) {
    set.endDate = patch.endDate;
  }
  if (Object.keys(set).length === 0) return;
  await ctx.db
    .update(plannedContributions)
    .set(set)
    .where(eq(plannedContributions.id, id))
    .run();
}

async function deletePlannedContribution(ctx: StoreContext, id: string): Promise<void> {
  await ctx.db.delete(plannedContributions).where(eq(plannedContributions.id, id)).run();
}

function assertOccurrenceIdentity(
  contribution: PlannedContribution,
  occurrenceId: string,
): void {
  const plannedDate = occurrenceId.slice(contribution.id.length + 1);
  if (
    !occurrenceId.startsWith(`${contribution.id}:`) ||
    expandPlannedContribution(contribution, plannedDate, plannedDate)[0]?.id !==
      occurrenceId
  ) {
    throw new Error("Occurrence identity is not generated by the contribution cadence.");
  }
}

async function readReconciliations(
  ctx: StoreContext,
  scopeId: string,
): Promise<ContributionOccurrenceReconciliation[]> {
  const rows = await ctx.db
    .select({
      occurrenceId: contributionOccurrenceReconciliations.occurrenceId,
      state: contributionOccurrenceReconciliations.state,
      storedExecutionMinor: contributionOccurrenceReconciliations.storedExecutionMinor,
      operationId: contributionOccurrenceOperations.operationId,
    })
    .from(contributionOccurrenceReconciliations)
    .innerJoin(
      plannedContributions,
      eq(contributionOccurrenceReconciliations.contributionId, plannedContributions.id),
    )
    .leftJoin(
      contributionOccurrenceOperations,
      eq(
        contributionOccurrenceOperations.occurrenceId,
        contributionOccurrenceReconciliations.occurrenceId,
      ),
    )
    .where(eq(plannedContributions.scopeId, scopeId))
    .orderBy(
      asc(contributionOccurrenceReconciliations.occurrenceId),
      asc(contributionOccurrenceOperations.operationId),
    )
    .all();

  const result = new Map<string, ContributionOccurrenceReconciliation>();
  for (const row of rows) {
    const current = result.get(row.occurrenceId) ?? {
      occurrenceId: row.occurrenceId,
      state: row.state,
      operationIds: [],
      ...(row.storedExecutionMinor === null
        ? {}
        : { storedExecutionMinor: row.storedExecutionMinor }),
    };
    if (row.operationId !== null) current.operationIds.push(row.operationId);
    result.set(row.occurrenceId, current);
  }
  return [...result.values()];
}

async function setOccurrenceState(
  ctx: StoreContext,
  input: SetOccurrenceStateInput,
): Promise<void> {
  if (
    input.storedExecutionMinor !== undefined &&
    (!Number.isInteger(input.storedExecutionMinor) || input.storedExecutionMinor < 0)
  ) {
    throw new Error("Stored execution must be a non-negative integer minor-unit amount.");
  }
  const contribution = await readContributionRow(ctx, input.contributionId);
  if (!contribution)
    throw new Error(`Planned contribution "${input.contributionId}" not found.`);
  assertOccurrenceIdentity(rowToContribution(contribution), input.occurrenceId);
  if (input.storedExecutionMinor !== undefined) {
    await assertStoredDestination(
      ctx,
      input.contributionId,
      contribution.destinationHoldingId,
    );
  }

  const links = await ctx.db
    .select({ operationId: contributionOccurrenceOperations.operationId })
    .from(contributionOccurrenceOperations)
    .where(eq(contributionOccurrenceOperations.occurrenceId, input.occurrenceId))
    .all();
  if (
    input.state === "skipped" &&
    (links.length > 0 || input.storedExecutionMinor !== undefined)
  ) {
    throw new Error("A skipped occurrence cannot retain execution truth.");
  }
  if (
    input.state === "fulfilled" &&
    links.length === 0 &&
    input.storedExecutionMinor === undefined
  ) {
    throw new Error(
      "A fulfilled occurrence requires an operation or stored-value receipt.",
    );
  }

  await ctx.db
    .insert(contributionOccurrenceReconciliations)
    .values({
      occurrenceId: input.occurrenceId,
      contributionId: input.contributionId,
      state: input.state,
      storedExecutionMinor: input.storedExecutionMinor ?? null,
    })
    .onConflictDoUpdate({
      target: contributionOccurrenceReconciliations.occurrenceId,
      set: {
        state: input.state,
        storedExecutionMinor: input.storedExecutionMinor ?? null,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .run();
}

async function linkOperation(
  ctx: StoreContext,
  input: LinkContributionOperationInput,
): Promise<void> {
  const contributionRow = await readContributionRow(ctx, input.contributionId);
  if (!contributionRow) throw new Error("Contribution not found.");
  assertOccurrenceIdentity(rowToContribution(contributionRow), input.occurrenceId);
  const row = await ctx.db
    .select({
      assetId: assetOperations.assetId,
      kind: assetOperations.kind,
    })
    .from(assetOperations)
    .where(eq(assetOperations.id, input.operationId))
    .get();
  if (!row) throw new Error("Operation not found.");
  if (row.kind !== "buy")
    throw new Error("Only buy operations can reconcile a contribution.");
  if (row.assetId !== contributionRow.destinationHoldingId) {
    throw new Error("Operation destination does not match the planned contribution.");
  }
  const existing = await ctx.db
    .select({ occurrenceId: contributionOccurrenceOperations.occurrenceId })
    .from(contributionOccurrenceOperations)
    .where(eq(contributionOccurrenceOperations.operationId, input.operationId))
    .get();
  if (existing && existing.occurrenceId !== input.occurrenceId) {
    throw new Error("Operation is already linked to another occurrence.");
  }
  const occurrence = await ctx.db
    .select({ state: contributionOccurrenceReconciliations.state })
    .from(contributionOccurrenceReconciliations)
    .where(eq(contributionOccurrenceReconciliations.occurrenceId, input.occurrenceId))
    .get();
  if (occurrence && occurrence.state !== "open") {
    throw new Error("A closed occurrence must be reopened before linking operations.");
  }
  await ctx.transaction(async () => {
    await ctx.db
      .insert(contributionOccurrenceReconciliations)
      .values({
        occurrenceId: input.occurrenceId,
        contributionId: input.contributionId,
        state: "open",
      })
      .onConflictDoNothing({ target: contributionOccurrenceReconciliations.occurrenceId })
      .run();
    await ctx.db
      .insert(contributionOccurrenceOperations)
      .values({ occurrenceId: input.occurrenceId, operationId: input.operationId })
      .onConflictDoNothing()
      .run();
  });
}

async function assertStoredDestination(
  ctx: StoreContext,
  contributionId: string,
  assetId: string,
): Promise<void> {
  const row = await ctx.db
    .select({
      destinationHoldingId: plannedContributions.destinationHoldingId,
      type: assets.type,
      valuationMethod: assets.valuationMethod,
    })
    .from(plannedContributions)
    .innerJoin(assets, eq(assets.id, plannedContributions.destinationHoldingId))
    .where(eq(plannedContributions.id, contributionId))
    .get();
  if (!row || row.destinationHoldingId !== assetId) {
    throw new Error("Stored-value destination does not match the planned contribution.");
  }
  if (
    (row.valuationMethod ?? defaultValuationMethodForAssetType(row.type)) !== "stored"
  ) {
    throw new Error("Only stored-value destinations use balance reconciliation.");
  }
}
