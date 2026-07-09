import type { AgentViewReadStore } from "@worthline/db";
import type { InvestmentOperation } from "@worthline/domain";
import { multiplyToMinor } from "@worthline/domain";

import {
  AgentViewHttpError,
  type AgentViewMoney,
  type AgentViewOperation,
  type AgentViewOperationPage,
  type AgentViewOperationSort,
} from "./contract";
import { compareDateId, decodeCursor, dropAfterCursor, encodeCursor } from "./cursor";
import { derivePublicId } from "./derived-id";
import { resolveInternalHoldingId } from "./scope-resolution";

export const DEFAULT_OPERATION_LIMIT = 100;
export const MAX_OPERATION_LIMIT = 500;

export interface BuildHoldingOperationsOptions {
  /** Public holding ID (`wl_hld_…`) selected by the caller. */
  holdingId: string;
  /** Chronological (`date`) or reverse (`-date`, default — newest first). */
  sort: AgentViewOperationSort;
  /** Page size, already clamped to `[1, MAX_OPERATION_LIMIT]` by the caller. */
  limit: number;
  /** Inclusive `YYYY-MM-DD` lower bound on operation date. */
  from?: string | undefined;
  /** Inclusive `YYYY-MM-DD` upper bound on operation date. */
  to?: string | undefined;
  /** Opaque cursor from a previous page's `meta.nextCursor`. */
  cursor?: string | undefined;
}

/** An operation paired with its derived public ID and date key. */
interface SortedOperation {
  operation: InvestmentOperation;
  publicId: string;
  dateKey: string;
}

/**
 * Assemble an investment holding's operations with no side effects (PRD #328,
 * #337): date filters, stable cursor pagination, and full money/decimal rows.
 * Reads persisted operations only — never replaces or ripples (ADR 0023). A
 * non-investment holding is a documented semantic error (`422`).
 */
export async function buildHoldingOperations(
  store: AgentViewReadStore,
  options: BuildHoldingOperationsOptions,
): Promise<AgentViewOperationPage> {
  const workspace = await store.readWorkspace();

  if (!workspace) {
    throw unknownHolding();
  }

  const internalHoldingId = await resolveInternalHoldingId(store, options.holdingId);
  const asset = (await store.readAssets()).find(
    (candidate) => candidate.id === internalHoldingId,
  );

  if (!asset || asset.type !== "investment") {
    throw new AgentViewHttpError({
      code: "unprocessable_entity",
      message: "Operations are only available for investment holdings.",
      status: 422,
    });
  }

  const currency = workspace.baseCurrency;
  const filtered = (await store.readOperations(internalHoldingId)).filter(
    (operation) =>
      (options.from === undefined || dateKey(operation) >= options.from) &&
      (options.to === undefined || dateKey(operation) <= options.to),
  );

  const sorted: SortedOperation[] = filtered
    .map((operation) => ({
      dateKey: dateKey(operation),
      operation,
      publicId: deriveOperationPublicId(operation.id),
    }))
    .sort((a, b) => compareDateId(a, b, options.sort));

  const afterCursor = options.cursor
    ? dropAfterCursor(
        sorted,
        decodeCursor(options.cursor),
        options.sort,
        (entry) => entry,
      )
    : sorted;

  const page = afterCursor.slice(0, options.limit);
  const hasNext = afterCursor.length > options.limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasNext && last ? encodeCursor(last.dateKey, last.publicId) : undefined;

  return {
    meta: {
      hasNext,
      limit: options.limit,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
    operations: page.map((entry) => toOperation(entry, currency)),
  };
}

function toOperation(entry: SortedOperation, currency: string): AgentViewOperation {
  const { operation } = entry;
  return {
    date: entry.dateKey,
    fees: moneyOf(operation.feesMinor, currency),
    grossAmount: moneyOf(
      multiplyToMinor(operation.units, operation.pricePerUnit),
      currency,
    ),
    id: entry.publicId,
    kind: operation.kind,
    object: "operation",
    pricePerUnit: operation.pricePerUnit,
    units: operation.units,
  };
}

/** The `YYYY-MM-DD` date key of an operation (`executedAt` may carry a time). */
function dateKey(operation: InvestmentOperation): string {
  return operation.executedAt.slice(0, 10);
}

/**
 * Derive an operation's opaque public ID from its stable internal id.
 * Deterministic, so it survives export/import (internal operation ids are
 * stable); opaque, so it leaks no internal id (ADR 0023). No registry write — a
 * read derives it without mutating state. Mirrors `deriveSnapshotPublicId`.
 */
export function deriveOperationPublicId(internalOperationId: string): string {
  return derivePublicId("op", internalOperationId);
}

function moneyOf(amountMinor: number, currency: string): AgentViewMoney {
  return { amountMinor, currency };
}

function unknownHolding(): AgentViewHttpError {
  return new AgentViewHttpError({
    code: "not_found",
    message: "Unknown holding.",
    status: 404,
  });
}
