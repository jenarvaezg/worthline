import { randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";
import {
  BENCHMARK_PRICE_SCHEMA,
  type BenchmarkPriceCache,
  createBenchmarkPriceCache,
} from "./control-plane/benchmark-price-cache";
import {
  createDailyCaptureLog,
  DAILY_CAPTURE_SCHEMA,
  type DailyCaptureLog,
} from "./control-plane/daily-capture-log";
import {
  createEntitlementDirectory,
  ENTITLEMENT_SCHEMA,
  type EntitlementDirectory,
} from "./control-plane/entitlement-directory";
import {
  createExposureProfileCatalog,
  EXPOSURE_PROFILE_SCHEMA,
  type ExposureProfileCatalog,
  type ExposureProfileCatalogAdmin,
} from "./control-plane/exposure-profile-catalog";
import { createJobStore, JOB_SCHEMA, type JobStore } from "./control-plane/job-store";
import {
  createMaintainerAlertLog,
  MAINTAINER_ALERT_SCHEMA,
  type MaintainerAlertLog,
} from "./control-plane/maintainer-alert-log";
import { migrateControlPlane } from "./control-plane/migrate";
import {
  createTenancyDirectory,
  TENANCY_SCHEMA,
  type TenancyDirectory,
} from "./control-plane/tenancy-directory";
import {
  createUsageLimits,
  USAGE_SCHEMA,
  type UsageLimits,
} from "./control-plane/usage-limits";
import { type LibsqlUrlTarget, openLibsqlClient } from "./libsql-client";

/**
 * The control plane (ADR 0030). A single small libSQL database — separate from
 * every per-workspace database — that maps **users** → **workspaces** →
 * **grants**. It is the only place that knows which workspace a signed-in user
 * owns; each workspace database itself still holds exactly one `id = 'default'`
 * row and knows nothing of users. Provision-on-first-login (see provisioner.ts)
 * writes the workspace + grant rows here.
 *
 * This module is the FACADE (ADR 0087): it composes the ports and owns nothing
 * else. Each port — its types, its tables, its SQL — lives in its own module
 * under `control-plane/`, so a change to jobs never touches tenancy, billing or
 * the catalog. The types below are re-exported so `./control-plane` stays the
 * single import path every consumer already uses.
 */

export type {
  BenchmarkPrice,
  BenchmarkPriceCache,
} from "./control-plane/benchmark-price-cache";
export type { DailyCaptureLog } from "./control-plane/daily-capture-log";
export type {
  EntitlementDirectory,
  GrantPremiumInput,
  StartTrialInput,
  UpdateWorkspaceBillingInput,
} from "./control-plane/entitlement-directory";
export type {
  ExposureProfileCatalog,
  ExposureProfileCatalogAdmin,
} from "./control-plane/exposure-profile-catalog";
export {
  DEFAULT_JOB_MAX_ATTEMPTS,
  type EnqueueJobInput,
  type EnqueueJobResult,
  type FailJobInput,
  type JobError,
  type JobRecord,
  type JobStatus,
  type JobStore,
  type LeaseJobInput,
  type RenewJobLeaseInput,
} from "./control-plane/job-store";
export type {
  MaintainerAlert,
  MaintainerAlertCategory,
  MaintainerAlertLog,
  MaintainerAlertOccurrence,
  MaintainerAlertStatus,
  MaintainerAlertWithOccurrences,
  RaisedMaintainerAlert,
  RaiseMaintainerAlertInput,
  UpdateMaintainerAlertStatusInput,
} from "./control-plane/maintainer-alert-log";
export type {
  ControlPlaneGrant,
  ControlPlaneUser,
  ControlPlaneWorkspace,
  ControlPlaneWorkspaceWithOwner,
  TenancyDirectory,
} from "./control-plane/tenancy-directory";
export type {
  AiDailyTokenUsage,
  AiTokenUsage,
  ProviderCooldown,
  UsageLimits,
  VisionCallDailyUsage,
  VisionCallUsage,
  WorkspaceDailyTokenUsage,
} from "./control-plane/usage-limits";

/**
 * The full control plane: one libSQL database (ADR 0030) exposing every
 * cohesive port over a single shared connection. Consumers should depend on the
 * narrowest port they use (e.g. {@link TenancyDirectory}, {@link JobStore}) so
 * no caller sees a concern it does not touch; this composite is the assembled
 * adapter returned by the factories and the type held by the composition root.
 */
export interface ControlPlaneStore
  extends TenancyDirectory,
    EntitlementDirectory,
    DailyCaptureLog,
    BenchmarkPriceCache,
    UsageLimits,
    ExposureProfileCatalog,
    MaintainerAlertLog,
    JobStore {
  close(): void;
}

/**
 * The admin control plane: the full {@link ControlPlaneStore} plus exposure-
 * profile catalog curation ({@link ExposureProfileCatalogAdmin}). Held ONLY by
 * the `/admin` surface, opened through {@link createAdminControlPlaneStore};
 * ordinary request-scoped consumers get the narrower {@link ControlPlaneStore},
 * whose {@link ExposureProfileCatalog} port cannot reach the catalog content
 * writes (#1123).
 */
export interface AdminControlPlaneStore
  extends ControlPlaneStore,
    ExposureProfileCatalogAdmin {}

export interface ControlPlaneStoreOptions {
  url?: string;
  authToken?: string;
  /** Id generator, injectable so tests stay deterministic. */
  newId?: () => string;
}

/**
 * The control plane's tables, assembled from each port's own fragment. A port
 * that gains a column edits its own module; this list only says which ports the
 * database holds. Tenancy comes first because the other fragments' foreign keys
 * point at it.
 */
const SCHEMA = [
  TENANCY_SCHEMA,
  ENTITLEMENT_SCHEMA,
  DAILY_CAPTURE_SCHEMA,
  USAGE_SCHEMA,
  BENCHMARK_PRICE_SCHEMA,
  EXPOSURE_PROFILE_SCHEMA,
  MAINTAINER_ALERT_SCHEMA,
  JOB_SCHEMA,
].join("\n");

async function buildControlPlaneStore(
  client: Client,
  newId: () => string,
): Promise<AdminControlPlaneStore> {
  await client.executeMultiple(SCHEMA);
  await migrateControlPlane(client);

  return {
    ...createTenancyDirectory(client, newId),
    ...createEntitlementDirectory(client),
    ...createDailyCaptureLog(client),
    ...createBenchmarkPriceCache(client),
    ...createUsageLimits(client),
    ...createExposureProfileCatalog(client),
    ...createMaintainerAlertLog(client, newId),
    ...createJobStore(client, newId),
    close() {
      client.close();
    },
  };
}

function openControlPlaneClient(
  options: ControlPlaneStoreOptions,
  callerName: string,
): Client {
  if (!options.url) {
    throw new Error(`${callerName} requires a url (libsql:// or file:).`);
  }
  const target: LibsqlUrlTarget = {
    url: options.url,
    ...(options.authToken ? { authToken: options.authToken } : {}),
  };
  return openLibsqlClient(target);
}

/**
 * Open the control plane for an ordinary request-scoped consumer: the narrow
 * {@link ControlPlaneStore}, which cannot reach exposure-catalog content writes
 * (#1123). The admin surface uses {@link createAdminControlPlaneStore} instead.
 */
export async function createControlPlaneStore(
  options: ControlPlaneStoreOptions = {},
): Promise<ControlPlaneStore> {
  return buildControlPlaneStore(
    openControlPlaneClient(options, "createControlPlaneStore"),
    options.newId ?? randomUUID,
  );
}

/**
 * Open the control plane with exposure-catalog curation writes (#1123) — the
 * `/admin` surface's opener. Identical wiring to {@link createControlPlaneStore},
 * only the wider {@link AdminControlPlaneStore} type.
 */
export async function createAdminControlPlaneStore(
  options: ControlPlaneStoreOptions = {},
): Promise<AdminControlPlaneStore> {
  return buildControlPlaneStore(
    openControlPlaneClient(options, "createAdminControlPlaneStore"),
    options.newId ?? randomUUID,
  );
}

/**
 * Open an ephemeral in-memory control plane — for tests. Returns the wide
 * {@link AdminControlPlaneStore} so persistence tests can exercise catalog
 * curation writes directly.
 */
export async function createInMemoryControlPlaneStore(
  options: Pick<ControlPlaneStoreOptions, "newId"> = {},
): Promise<AdminControlPlaneStore> {
  return buildControlPlaneStore(
    openLibsqlClient(":memory:"),
    options.newId ?? randomUUID,
  );
}
