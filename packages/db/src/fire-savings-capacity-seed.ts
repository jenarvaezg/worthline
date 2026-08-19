import type { ContributionPlan, FireScopeConfig } from "@worthline/domain";
import { plannedMonthlyContributionsMinor } from "@worthline/domain";
import { eq } from "drizzle-orm";

import { appSettings } from "./schema";
import type { StoreContext } from "./store-context";

/** The row the v56 ladder step enqueues, and this seed consumes. */
const SEED_MARKER_KEY = "fire.capacity_seed.v56";
const SEED_PENDING = "pending";

/** One scope's seeded figure — returned so a caller (or a test) can assert it. */
export interface SeededFireSavingsCapacity {
  scopeId: string;
  capacityMinor: number;
}

/** Ports the seed reads the plan through, so it uses the store's own reader. */
export interface FireSavingsCapacitySeedDeps {
  readContributionPlan: (scopeId: string) => Promise<ContributionPlan>;
  readUnitPrices: () => Promise<Record<string, string>>;
}

/**
 * The one-shot data seed the v56 ladder step enqueues (#1416, ADR 0074).
 *
 * The FIRE projection no longer derives its monthly savings from the contribution
 * plan — the declared scalar is the only input. A scope that had been living off
 * the derivation and never typed a scalar would therefore drop to 0 €/month the
 * moment this ships, moving its FIRE date by years with nothing on screen saying
 * why. So it keeps exactly the figure it projects today, written into
 * `monthlySavingsCapacityMinor` and marked `monthlySavingsCapacitySeededFromPlan`
 * so the assumptions form can say "we put this here, check it".
 *
 * **It preserves; it never invents.** The only figure written is the plan's own
 * active monthly total — bounded by the plan, and identical to what the retired
 * derivation returned. Every other shape ALREADY projects 0 today and keeps
 * projecting 0, so there is nothing to preserve and nothing is written:
 *
 * - Rows that have all **expired** summed to 0 under the old code too. (That was
 *   the second half of the bug — the guard asked whether the plan was *empty*, not
 *   whether it was *active*. It disappears with the derivation: what the projection
 *   reads is now the field the user can see, empty, in the form.)
 * - An active **units** row whose destination has no cached price made the old
 *   resolver fall back to the scalar, i.e. to 0 as well.
 *
 * Deriving a figure from measured savings here was considered and dropped:
 * `suggestMonthlySavingsCapacity` divides net invested by the months its operations
 * span, so one 200.000 € lump sum in one month reads as 200.000 €/mes. Writing that
 * into a config — once, irreversibly, in the flattering direction — is the failure
 * mode ADR 0073 and ADR 0074 both exist to stop. Measured savings stay what they
 * are: the form's placeholder, and #1449's warning.
 *
 * Two mechanics worth naming:
 *
 * - It reads the **stored** config, never `readFireConfig`. That reader resolves
 *   `currentAge` from the members' birth dates (#1415); writing the resolved config
 *   back would freeze the very age that change un-froze.
 * - The gate is a persisted row, not a flag from `migrate()`. The ladder runs in
 *   places that discard its result (`runBootstrapHealthcheck`) and the version bump
 *   commits before this work, so an in-flight boolean can be consumed by a process
 *   that never seeds, or lost to an error. A `pending` row survives both: it is only
 *   flipped to its completion stamp inside the same transaction as the write.
 */
export async function seedDeclaredFireSavingsCapacity(
  ctx: StoreContext,
  deps: FireSavingsCapacitySeedDeps,
  /**
   * Wall clock, read ONLY when the marker says there is work. Every store open
   * calls this seed, and an injected test clock steps on each call — consuming a
   * tick here would shift the stamps of every unrelated store the suite builds.
   */
  now: () => string,
): Promise<SeededFireSavingsCapacity[]> {
  const marker = await ctx.db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SEED_MARKER_KEY))
    .get();
  if (marker?.value !== SEED_PENDING) return [];

  const nowISO = now();
  const todayISO = nowISO.slice(0, 10);

  // Read the plans OUTSIDE the transaction: they are the slow part, they cannot
  // change the decision (a plan edit needs a scalar the candidate does not have),
  // and the config itself is re-read inside the transaction anyway.
  const stored = await readStoredFireConfig(ctx);
  const candidates = Object.keys(stored).filter(
    (scopeId) => stored[scopeId]?.monthlySavingsCapacityMinor === undefined,
  );

  const plannedByScope = new Map<string, number>();
  if (candidates.length > 0) {
    const unitPrices = await deps.readUnitPrices();
    for (const scopeId of candidates) {
      const plan = await deps.readContributionPlan(scopeId);
      const plannedMinor = plannedMonthlyContributionsMinor(plan, todayISO, unitPrices);
      if (plannedMinor !== null && plannedMinor > 0) {
        plannedByScope.set(scopeId, plannedMinor);
      }
    }
  }

  // Re-read and write under one transaction: without it, a user who saves the FIRE
  // form in the window between the read and the write loses the figure he just
  // typed — and the band would then tell him the app put the plan's number there.
  return ctx.transaction(async () => {
    const current = await readStoredFireConfig(ctx);
    const seeded: SeededFireSavingsCapacity[] = [];
    const next: Record<string, FireScopeConfig> = { ...current };

    for (const [scopeId, capacityMinor] of plannedByScope) {
      const config = current[scopeId];
      // Gone, or declared since we read: leave it alone.
      if (!config || config.monthlySavingsCapacityMinor !== undefined) continue;
      next[scopeId] = {
        ...config,
        monthlySavingsCapacityMinor: capacityMinor,
        monthlySavingsCapacitySeededFromPlan: true,
      };
      seeded.push({ scopeId, capacityMinor });
    }

    if (seeded.length > 0) {
      await writeAppSetting(ctx, "fire.config", JSON.stringify(next), nowISO);
      // One row per seeded scope in one batched statement (#1435).
      await ctx.writeAuditEntries(
        seeded.map((entry) => ({
          action: "seed_fire_savings_capacity",
          details: { capacityMinor: entry.capacityMinor, from: "plan" },
          entityId: entry.scopeId,
          entityType: "fire_config",
        })),
      );
    }

    // Always retire the marker — including when nothing needed seeding — so the
    // read above costs one lookup once, not one on every store open forever.
    await writeAppSetting(ctx, SEED_MARKER_KEY, nowISO, nowISO);
    return seeded;
  });
}

async function readStoredFireConfig(
  ctx: StoreContext,
): Promise<Record<string, FireScopeConfig>> {
  const row = await ctx.db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "fire.config"))
    .get();
  return row ? (JSON.parse(row.value) as Record<string, FireScopeConfig>) : {};
}

async function writeAppSetting(
  ctx: StoreContext,
  key: string,
  value: string,
  updatedAt: string,
): Promise<void> {
  await ctx.db
    .insert(appSettings)
    .values({ key, updatedAt, value })
    .onConflictDoUpdate({ set: { updatedAt, value }, target: appSettings.key })
    .run();
}
