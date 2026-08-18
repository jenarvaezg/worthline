import type { CommandResult, FactBatchInput, RipplePlan, UnitOfWork } from "./types";

function sqliteErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { cause?: unknown; code?: unknown; extendedCode?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  if (typeof candidate.extendedCode === "string") return candidate.extendedCode;
  return candidate.cause === error ? undefined : sqliteErrorCode(candidate.cause);
}

function deepestErrorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { cause?: unknown; message?: unknown };
  const nested =
    candidate.cause === error ? undefined : deepestErrorMessage(candidate.cause);
  if (nested !== undefined) return nested;
  return typeof candidate.message === "string" ? candidate.message : undefined;
}

/**
 * One persistence step inside a batch — returns the date key of the fact it
 * wrote, or ALL of them when the step persists a batch of facts in one write
 * (a balance-history chain, #1435). Either way the keys feed the ripple floor.
 */
export interface DatedFactStep {
  persist: (batchId: string) => Promise<string | readonly string[]>;
}

export interface ApplyDatedFactsBatchParams {
  /** Provenance for this application. Defaults to an interactive/manual command. */
  batch?: FactBatchInput;
  today: string;
  steps: DatedFactStep[];
  /** Re-derive snapshots from the computed from-date. */
  ripple: (fromDateKey: string) => Promise<void>;
  /**
   * Derive the ripple floor from the collected date keys. Defaults to the
   * earliest key — override for edits where the floor is min(old, new).
   */
  deriveFromDateKey?: (dateKeys: string[]) => string | null;
  /**
   * Bookkeeping to run INSIDE the same transaction, after every fact step and
   * before the ripple — e.g. a connector advancing its cursor and dedup ledger,
   * which must commit or roll back atomically with the facts (decision #888).
   * Runs even for an empty batch (a no-op sync still records its freshness).
   * Contributes no date keys, so the ripple floor is unaffected.
   */
  afterPersist?: (batchId: string) => Promise<void>;
}

/**
 * Persist a batch of dated facts and run ONE ripple in a single transaction
 * (ADR 0020, architecture review #966). Shared primitive for investment,
 * debt, housing and historical ingestion tracers.
 */
export async function applyDatedFactsBatch(
  uow: UnitOfWork,
  params: ApplyDatedFactsBatchParams,
): Promise<CommandResult<RipplePlan | null>> {
  try {
    return await uow.transaction(async () => {
      const batchId = await uow.createFactBatch(params.batch ?? { trigger: "manual" });
      const dateKeys: string[] = [];
      for (const step of params.steps) {
        const written = await step.persist(batchId);
        if (typeof written === "string") dateKeys.push(written);
        else dateKeys.push(...written);
      }

      await params.afterPersist?.(batchId);

      if (dateKeys.length === 0) {
        return { ok: true, value: null };
      }

      const fromDateKey =
        params.deriveFromDateKey?.(dateKeys) ?? [...dateKeys].sort()[0]!;

      if (fromDateKey > params.today) {
        return { ok: true, value: null };
      }

      await params.ripple(fromDateKey);
      return {
        ok: true,
        value: { fromDateKey, today: params.today },
      };
    });
  } catch (error) {
    const topLevelMessage = error instanceof Error ? error.message : String(error);
    const causeMessage = deepestErrorMessage(error);
    const message =
      causeMessage === undefined || causeMessage === topLevelMessage
        ? topLevelMessage
        : `${topLevelMessage}\nCaused by: ${causeMessage}`;
    const code = sqliteErrorCode(error);
    return { ok: false, error: message, ...(code === undefined ? {} : { code }) };
  }
}
