/**
 * Local↔prod sync engine (S7 #388, ADR 0030). Two operations over the existing
 * export/import machinery (ADR 0010):
 *   - `syncPull` exports the prod workspace and imports it into local;
 *   - `syncPush` full-replaces prod with local.
 * The export carries the full frozen snapshot history (ADR 0010/0012/0015), so
 * history round-trips, not just current balances.
 *
 * `push` is destructive, so it is guarded:
 *   - it backs prod up (a timestamped export) BEFORE overwriting;
 *   - it ABORTS if prod changed since the last pull (a fingerprint mismatch),
 *     so a concurrent prod write is never silently clobbered;
 *   - because the export omits connected-source secrets by design (ADR 0016),
 *     it snapshots prod's secrets and re-applies them after the full-replace, so
 *     the live connection is never severed. The first push into a fresh prod
 *     (no prior pull) doubles as the one-time real-data load.
 *
 * The engine is storage-agnostic — it drives two {@link WorthlineStore}s and an
 * injected {@link SyncDeps} (the last-pull fingerprint, backup sink, clock) — so
 * it is exercised with two in-memory workspaces and wired to the real
 * local-file / Turso databases by the `sync:pull` / `sync:push` scripts.
 */
import { createHash } from "node:crypto";

import type { WorkspaceExport } from "@worthline/domain";

import type { WorthlineStore } from "./index";

/** Thrown by {@link syncPush} when prod changed since the last pull. */
export class SyncStaleError extends Error {
  constructor(message = "Prod changed since the last pull — pull again before pushing.") {
    super(message);
    this.name = "SyncStaleError";
  }
}

/** Injected side effects the engine needs but does not own. */
export interface SyncDeps {
  /** The fingerprint of the prod state last synced with (null if never). */
  readLastPull(): string | null | Promise<string | null>;
  /** Persist the fingerprint of the prod state now synced with. */
  writeLastPull(fingerprint: string): void | Promise<void>;
  /** Persist a timestamped backup of prod before a destructive push. */
  backup(doc: WorkspaceExport, label: string): void | Promise<void>;
  /** A label (timestamp) source for the backup — injected for determinism. */
  now(): string;
}

/**
 * Order-independent stringify, so the fingerprint is stable across runs. Assumes
 * the export carries no explicit-`undefined` values (the serializer omits absent
 * keys) and that arrays are already in a canonical order (every export reader
 * uses a stable ORDER BY), so only object keys need sorting here.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    );
  return `{${entries.join(",")}}`;
}

/** A content fingerprint of an export document (secrets are not in it). */
export function fingerprintExport(doc: WorkspaceExport): string {
  return createHash("sha256").update(stableStringify(doc)).digest("hex");
}

type SecretSnapshot = Map<string, { credentialsJson: string; tokenJson: string | null }>;

/** Capture every source's live secret, keyed by source id, before a replace. */
async function snapshotSecrets(store: WorthlineStore): Promise<SecretSnapshot> {
  const out: SecretSnapshot = new Map();
  for (const source of await store.connectedSources.listSources()) {
    out.set(source.id, {
      credentialsJson: source.credentialsJson,
      tokenJson: source.tokenJson,
    });
  }
  return out;
}

/** A source whose credentials are just the empty placeholder (no live secret). */
const PLACEHOLDER_CREDENTIALS = "{}";

/** Re-apply captured secrets to the matching sources after a full-replace. */
async function reapplySecrets(
  store: WorthlineStore,
  secrets: SecretSnapshot,
): Promise<void> {
  for (const source of await store.connectedSources.listSources()) {
    const snap = secrets.get(source.id);
    // No snapshot (a source local added) or only a placeholder (prod never had a
    // live key) ⇒ leave the imported "{}" intact, so "needs a key" stays visible.
    if (!snap || snap.credentialsJson === PLACEHOLDER_CREDENTIALS) continue;
    await store.connectedSources.updateCredentials(source.id, snap.credentialsJson);
    if (snap.tokenJson !== null) {
      await store.connectedSources.saveToken(source.id, snap.tokenJson);
    }
  }
}

export interface PullResult {
  /** Fingerprint of the prod state just pulled (the new staleness baseline). */
  fingerprint: string;
}

/** Prod → local: export prod and import it into local, recording the baseline. */
export async function syncPull(
  prod: WorthlineStore,
  local: WorthlineStore,
  deps: SyncDeps,
): Promise<PullResult> {
  const doc = await prod.workspace.exportWorkspace();
  await local.workspace.importWorkspace(doc);
  const fingerprint = fingerprintExport(doc);
  await deps.writeLastPull(fingerprint);
  return { fingerprint };
}

export interface PushResult {
  /** The label of the prod backup written before the replace. */
  backupLabel: string;
  /** Fingerprint of the new prod state (the new staleness baseline). */
  fingerprint: string;
  /**
   * Labels of prod sources whose live secret could not be restored — a source
   * local added (or replaced with a new id) carries only a "{}" placeholder, so
   * its connection needs its key re-entered in prod. Empty in the common case.
   */
  sourcesMissingSecret: string[];
}

/** Local → prod: backup prod, abort if it drifted, then full-replace + re-seal. */
export async function syncPush(
  local: WorthlineStore,
  prod: WorthlineStore,
  deps: SyncDeps,
): Promise<PushResult> {
  // Staleness guard FIRST — never back up or overwrite a prod that drifted.
  const prodDoc = await prod.workspace.exportWorkspace();
  const lastPull = await deps.readLastPull();
  if (lastPull !== null && lastPull !== fingerprintExport(prodDoc)) {
    throw new SyncStaleError();
  }

  // Backup prod before the destructive replace.
  const label = deps.now();
  await deps.backup(prodDoc, label);

  // The export omits secrets (ADR 0016), so capture prod's before overwriting.
  const secrets = await snapshotSecrets(prod);

  const localDoc = await local.workspace.exportWorkspace();
  await prod.workspace.importWorkspace(localDoc);

  // Re-apply prod's secrets so the live connection survives the full-replace.
  await reapplySecrets(prod, secrets);

  // Any prod source left with the placeholder needs its key re-entered.
  const sourcesMissingSecret = (await prod.connectedSources.listSources())
    .filter((source) => source.credentialsJson === PLACEHOLDER_CREDENTIALS)
    .map((source) => source.label);

  // Baseline = prod's ACTUAL post-import state. `importWorkspace` gap-fills
  // historical snapshots after the bulk insert (ADR 0012), so prod can hold rows
  // `localDoc` lacks; fingerprinting prod's real export (secrets omitted) is what
  // the next push's guard will read, so a re-push without a re-pull never
  // false-aborts.
  const fingerprint = fingerprintExport(await prod.workspace.exportWorkspace());
  await deps.writeLastPull(fingerprint);
  return { backupLabel: label, fingerprint, sourcesMissingSecret };
}
