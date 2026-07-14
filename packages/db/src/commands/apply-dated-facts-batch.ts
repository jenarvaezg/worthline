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

/** One dated fact to persist inside a batch — returns its date key. */
export interface DatedFactStep {
  persist: (batchId: string) => Promise<string>;
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
        dateKeys.push(await step.persist(batchId));
      }

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
