import type { Client } from "@libsql/client";
import type {
  CreateGlobalExposureProfileInput,
  GlobalExposureProfile,
  GlobalExposureProfileBreakdowns,
  GlobalExposureProfileIdentity,
  InvestmentPriceProvider,
  RawGlobalExposureProfileIdentityInput,
  UpdateGlobalExposureProfileInput,
} from "@worthline/domain";
import {
  createValidatedGlobalExposureProfileInput,
  globalExposureProfileIdentityKey,
  resolveGlobalExposureProfileIdentity,
  validateGlobalExposureProfileContent,
} from "@worthline/domain";

/** The table owned by the exposure-catalog port (PRD #711 S1 / #940, ADR 0058). */
export const EXPOSURE_PROFILE_SCHEMA = `
CREATE TABLE IF NOT EXISTS global_exposure_profiles (
  identity_key TEXT PRIMARY KEY NOT NULL,
  identity_kind TEXT NOT NULL,
  isin TEXT,
  price_provider TEXT,
  provider_symbol TEXT,
  display_name TEXT,
  breakdowns_json TEXT NOT NULL DEFAULT '{}',
  ter TEXT,
  tracked_index TEXT,
  hedged_to_currency TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS global_exposure_profiles_isin
  ON global_exposure_profiles(isin) WHERE isin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS global_exposure_profiles_provider
  ON global_exposure_profiles(price_provider, provider_symbol)
  WHERE price_provider IS NOT NULL AND provider_symbol IS NOT NULL;
`;

/**
 * Read + system-registration access to the global exposure-profile catalog
 * (PRD #711 S1 / #940, ADR 0058). This is the broadly-visible port every
 * control-plane consumer may hold: reading the catalog, and registering the
 * empty stub a holding is born with. Content CURATION (create / update / rekey /
 * delete) deliberately does NOT live here — it is on {@link
 * ExposureProfileCatalogAdmin}, off this port, so no ordinary caller can rewrite
 * curated data (#1123, retaining the capability in the interface).
 */
export interface ExposureProfileCatalog {
  /**
   * Register an empty, curatable catalog row for a market holding's identity if
   * one does not already exist (#1097, ADR 0058 amendment). Idempotent by
   * `identity_key` and NON-destructive: an existing row — curated data or a prior
   * stub — is left untouched (no display-name rewrite). This is a system action
   * (the row is born with the holding), distinct from admin data curation
   * (`createGlobalExposureProfile`/`updateGlobalExposureProfile`), so it never
   * validates content and is allowed to be completely empty.
   */
  ensureGlobalExposureProfileStub(
    identity: GlobalExposureProfileIdentity,
    displayName?: string | null,
  ): Promise<void>;
  readGlobalExposureProfile(
    identity: RawGlobalExposureProfileIdentityInput,
  ): Promise<GlobalExposureProfile | null>;
  readGlobalExposureProfiles(): Promise<GlobalExposureProfile[]>;
}

/**
 * Admin curation of the global exposure-profile catalog (PRD #711 S4, decision
 * #941). These content writes are the capability #1123 retains in the interface:
 * they are reachable ONLY through the admin control-plane surface ({@link
 * createAdminControlPlaneStore} / the `/admin/catalogo` server actions), never
 * from the base {@link ControlPlaneStore} a request-scoped consumer holds. A
 * non-admin surface rewriting curated catalog content is now unrepresentable by
 * type, not merely grep-detectable.
 */
export interface ExposureProfileCatalogAdmin extends ExposureProfileCatalog {
  createGlobalExposureProfile(
    input: CreateGlobalExposureProfileInput,
  ): Promise<GlobalExposureProfile>;
  updateGlobalExposureProfile(
    identity: RawGlobalExposureProfileIdentityInput,
    input: UpdateGlobalExposureProfileInput,
  ): Promise<GlobalExposureProfile>;
  rekeyGlobalExposureProfile(
    from: RawGlobalExposureProfileIdentityInput,
    to: RawGlobalExposureProfileIdentityInput,
  ): Promise<GlobalExposureProfile>;
  deleteGlobalExposureProfile(
    identity: RawGlobalExposureProfileIdentityInput,
  ): Promise<void>;
}

function toGlobalExposureProfileIdentity(
  row: Record<string, unknown>,
): GlobalExposureProfileIdentity {
  const kind = String(row["identity_kind"]);
  if (kind === "isin") {
    return { isin: String(row["isin"]), kind: "isin" };
  }
  return {
    kind: "provider",
    priceProvider: String(row["price_provider"]) as InvestmentPriceProvider,
    providerSymbol: String(row["provider_symbol"]),
  };
}

function toGlobalExposureProfile(row: Record<string, unknown>): GlobalExposureProfile {
  return {
    identity: toGlobalExposureProfileIdentity(row),
    displayName: row["display_name"] == null ? null : String(row["display_name"]),
    breakdowns: JSON.parse(
      String(row["breakdowns_json"]),
    ) as GlobalExposureProfileBreakdowns,
    ter: row["ter"] == null ? null : String(row["ter"]),
    trackedIndex: row["tracked_index"] == null ? null : String(row["tracked_index"]),
    hedgedToCurrency:
      row["hedged_to_currency"] == null ? null : String(row["hedged_to_currency"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function identityColumns(identity: GlobalExposureProfileIdentity): {
  identityKey: string;
  identityKind: string;
  isin: string | null;
  priceProvider: string | null;
  providerSymbol: string | null;
} {
  if (identity.kind === "isin") {
    return {
      identityKey: globalExposureProfileIdentityKey(identity),
      identityKind: "isin",
      isin: identity.isin,
      priceProvider: null,
      providerSymbol: null,
    };
  }
  return {
    identityKey: globalExposureProfileIdentityKey(identity),
    identityKind: "provider",
    isin: null,
    priceProvider: identity.priceProvider,
    providerSymbol: identity.providerSymbol,
  };
}

export function createExposureProfileCatalog(
  client: Client,
): ExposureProfileCatalogAdmin {
  return {
    async createGlobalExposureProfile(input) {
      const validated = createValidatedGlobalExposureProfileInput(input);
      const columns = identityColumns(validated.identity);
      const existing = await client.execute({
        sql: "SELECT identity_key FROM global_exposure_profiles WHERE identity_key = ?",
        args: [columns.identityKey],
      });
      if (existing.rows.length > 0) {
        throw new Error("Global exposure profile identity already exists.");
      }

      await client.execute({
        sql: `INSERT INTO global_exposure_profiles (
                identity_key, identity_kind, isin, price_provider, provider_symbol,
                display_name, breakdowns_json, ter, tracked_index, hedged_to_currency
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          columns.identityKey,
          columns.identityKind,
          columns.isin,
          columns.priceProvider,
          columns.providerSymbol,
          validated.displayName,
          JSON.stringify(validated.breakdowns),
          validated.ter,
          validated.trackedIndex,
          validated.hedgedToCurrency,
        ],
      });

      const created = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [columns.identityKey],
      });
      return toGlobalExposureProfile(created.rows[0]!);
    },
    async ensureGlobalExposureProfileStub(identity, displayName) {
      const columns = identityColumns(identity);
      const name = (displayName ?? "").trim() || null;
      // Non-destructive: ON CONFLICT DO NOTHING leaves a pre-existing row (curated
      // data or an earlier stub) exactly as it was — breakdowns default to '{}',
      // the metadata columns to null, the timestamps to CURRENT_TIMESTAMP.
      await client.execute({
        sql: `INSERT INTO global_exposure_profiles (
                identity_key, identity_kind, isin, price_provider, provider_symbol, display_name
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(identity_key) DO NOTHING`,
        args: [
          columns.identityKey,
          columns.identityKind,
          columns.isin,
          columns.priceProvider,
          columns.providerSymbol,
          name,
        ],
      });
    },
    async updateGlobalExposureProfile(identityInput, input) {
      const identity = resolveGlobalExposureProfileIdentity(identityInput);
      const validated = validateGlobalExposureProfileContent(input);
      const identityKey = globalExposureProfileIdentityKey(identity);
      const existing = await client.execute({
        sql: "SELECT created_at FROM global_exposure_profiles WHERE identity_key = ?",
        args: [identityKey],
      });
      if (existing.rows.length === 0) {
        throw new Error("Global exposure profile not found.");
      }

      await client.execute({
        sql: `UPDATE global_exposure_profiles SET
                display_name = ?,
                breakdowns_json = ?,
                ter = ?,
                tracked_index = ?,
                hedged_to_currency = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE identity_key = ?`,
        args: [
          validated.displayName,
          JSON.stringify(validated.breakdowns),
          validated.ter,
          validated.trackedIndex,
          validated.hedgedToCurrency,
          identityKey,
        ],
      });

      const updated = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [identityKey],
      });
      const profile = toGlobalExposureProfile(updated.rows[0]!);
      return {
        ...profile,
        createdAt: String(existing.rows[0]!.created_at),
      };
    },
    async rekeyGlobalExposureProfile(fromInput, toInput) {
      const from = resolveGlobalExposureProfileIdentity(fromInput);
      const to = resolveGlobalExposureProfileIdentity(toInput);
      const fromKey = globalExposureProfileIdentityKey(from);
      const toColumns = identityColumns(to);

      const existing = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [fromKey],
      });
      if (existing.rows.length === 0) {
        throw new Error("Global exposure profile not found.");
      }

      const collision = await client.execute({
        sql: "SELECT identity_key FROM global_exposure_profiles WHERE identity_key = ?",
        args: [toColumns.identityKey],
      });
      if (collision.rows.length > 0) {
        throw new Error("Global exposure profile identity already exists.");
      }

      const current = existing.rows[0]!;
      await client.execute({
        sql: `UPDATE global_exposure_profiles SET
                identity_key = ?,
                identity_kind = ?,
                isin = ?,
                price_provider = ?,
                provider_symbol = ?,
                updated_at = CURRENT_TIMESTAMP
              WHERE identity_key = ?`,
        args: [
          toColumns.identityKey,
          toColumns.identityKind,
          toColumns.isin,
          toColumns.priceProvider,
          toColumns.providerSymbol,
          fromKey,
        ],
      });

      const rekeyed = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [toColumns.identityKey],
      });
      const profile = toGlobalExposureProfile(rekeyed.rows[0]!);
      return {
        ...profile,
        createdAt: String(current.created_at),
      };
    },
    async deleteGlobalExposureProfile(identityInput) {
      const identity = resolveGlobalExposureProfileIdentity(identityInput);
      const identityKey = globalExposureProfileIdentityKey(identity);
      await client.execute({
        sql: "DELETE FROM global_exposure_profiles WHERE identity_key = ?",
        args: [identityKey],
      });
    },
    async readGlobalExposureProfile(identityInput) {
      const identity = resolveGlobalExposureProfileIdentity(identityInput);
      const result = await client.execute({
        sql: "SELECT * FROM global_exposure_profiles WHERE identity_key = ?",
        args: [globalExposureProfileIdentityKey(identity)],
      });
      return result.rows.length > 0 ? toGlobalExposureProfile(result.rows[0]!) : null;
    },
    async readGlobalExposureProfiles() {
      const result = await client.execute(
        `SELECT * FROM global_exposure_profiles
         ORDER BY identity_kind ASC, identity_key ASC`,
      );
      return result.rows.map((row) => toGlobalExposureProfile(row));
    },
  };
}
