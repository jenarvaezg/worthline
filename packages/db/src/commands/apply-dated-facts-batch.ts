import type { CommandResult, RipplePlan, UnitOfWork } from "./types";

/** One dated fact to persist inside a batch — returns its date key. */
export interface DatedFactStep {
  persist: () => Promise<string>;
}

export interface ApplyDatedFactsBatchParams {
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
      const dateKeys: string[] = [];
      for (const step of params.steps) {
        dateKeys.push(await step.persist());
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
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
