import type { ExposureBreakdowns, ExposureProfile } from "@worthline/domain";
import { asc, eq } from "drizzle-orm";

import { exposureProfiles } from "./schema";
import type { StoreContext } from "./store-context";

/**
 * Exposure-profile persistence (PRD #539 / ADR 0039): read-only access to
 * hand-entered exposure profiles keyed by the security's identity
 * (`isin ?? providerSymbol`). Workspace surfaces no longer write profiles
 * (#1014); the only writer is admin CRUD on the control plane (S4).
 */
export interface ExposureProfileStore {
  /** Every stored (hand-entered) profile, ordered by key for stable exports. */
  readExposureProfiles: () => Promise<ExposureProfile[]>;
  /** One profile by key, or null when the security has no hand-entered profile. */
  readExposureProfile: (key: string) => Promise<ExposureProfile | null>;
}

export function createExposureProfileStore(ctx: StoreContext): ExposureProfileStore {
  return {
    readExposureProfiles: () => readExposureProfiles(ctx),
    readExposureProfile: (key) => readExposureProfile(ctx, key),
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
