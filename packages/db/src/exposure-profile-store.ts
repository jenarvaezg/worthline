import type {
  CreateExposureProfileInput,
  ExposureBreakdowns,
  ExposureProfile,
} from "@worthline/domain";
import { asc, eq, sql } from "drizzle-orm";

import { exposureProfiles } from "./schema";
import type { StoreContext } from "./store-context";

/**
 * Exposure-profile persistence (PRD #539 / ADR 0039): hand-entered exposure
 * profiles keyed by the security's identity (`isin ?? providerSymbol`). A
 * profile is a *shared canonical row* — every holding of the same security
 * resolves to it — so writing is an upsert by key, not a create/update pair.
 *
 * Only hand-entered profiles live here; auto-derived ones (cash/crypto/…) are
 * recomputed in domain code and never stored. The breakdown vectors stay JSON
 * because look-through is computed in domain, not by SQL, and there is no
 * reconciliation sub-invariant (they are non-figure reference metadata, clear of
 * ADR 0008).
 */
export interface ExposureProfileStore {
  /** Every stored (hand-entered) profile, ordered by key for stable exports. */
  readExposureProfiles: () => Promise<ExposureProfile[]>;
  /** One profile by key, or null when the security has no hand-entered profile. */
  readExposureProfile: (key: string) => Promise<ExposureProfile | null>;
  /** Upsert the canonical row for this key, preserving fields omitted by the write. */
  saveExposureProfile: (profile: CreateExposureProfileInput) => Promise<void>;
  deleteExposureProfile: (key: string) => Promise<void>;
}

export function createExposureProfileStore(ctx: StoreContext): ExposureProfileStore {
  return {
    readExposureProfiles: () => readExposureProfiles(ctx),
    readExposureProfile: (key) => readExposureProfile(ctx, key),
    saveExposureProfile: (profile) => saveExposureProfile(ctx, profile),
    deleteExposureProfile: (key) => deleteExposureProfile(ctx, key),
  };
}

type ExposureProfileRow = typeof exposureProfiles.$inferSelect;

function rowToProfile(row: ExposureProfileRow): ExposureProfile {
  return {
    key: row.key,
    source: row.source,
    declaredAt: row.declaredAt,
    trackedIndex: row.trackedIndex,
    ter: row.ter,
    hedged: row.hedged === 1,
    breakdowns: JSON.parse(row.breakdownsJson) as ExposureBreakdowns,
  };
}

async function readExposureProfiles(ctx: StoreContext): Promise<ExposureProfile[]> {
  const rows = await ctx.db
    .select()
    .from(exposureProfiles)
    .orderBy(asc(exposureProfiles.key))
    .all();
  return rows.map(rowToProfile);
}

async function readExposureProfile(
  ctx: StoreContext,
  key: string,
): Promise<ExposureProfile | null> {
  const row = await ctx.db
    .select()
    .from(exposureProfiles)
    .where(eq(exposureProfiles.key, key))
    .get();
  return row ? rowToProfile(row) : null;
}

async function saveExposureProfile(
  ctx: StoreContext,
  profile: CreateExposureProfileInput,
): Promise<void> {
  const current = await readExposureProfile(ctx, profile.key);
  const declaredAt = profile.declaredAt ?? new Date().toISOString();
  const values = {
    key: profile.key,
    source: profile.source ?? "user",
    declaredAt,
    trackedIndex:
      profile.trackedIndex !== undefined
        ? profile.trackedIndex
        : (current?.trackedIndex ?? null),
    ter: profile.ter !== undefined ? profile.ter : (current?.ter ?? null),
    hedged: (profile.hedged ?? current?.hedged ?? false) ? 1 : 0,
    breakdownsJson: JSON.stringify(
      mergeBreakdowns(current?.breakdowns, profile.breakdowns),
    ),
  };
  await ctx.db
    .insert(exposureProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: exposureProfiles.key,
      set: {
        trackedIndex: values.trackedIndex,
        ter: values.ter,
        hedged: values.hedged,
        breakdownsJson: values.breakdownsJson,
        source: values.source,
        declaredAt: values.declaredAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .run();
}

function mergeBreakdowns(
  current: ExposureBreakdowns | undefined,
  next: ExposureBreakdowns | undefined,
): ExposureBreakdowns {
  return {
    ...(current ?? {}),
    ...(next ?? {}),
  };
}

async function deleteExposureProfile(ctx: StoreContext, key: string): Promise<void> {
  await ctx.db.delete(exposureProfiles).where(eq(exposureProfiles.key, key)).run();
}
