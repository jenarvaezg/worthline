/**
 * The one place `apps/web` opens the control plane (#1694, ADR 0087).
 *
 * Before this module the block «read the URL from env → spread `authToken` only
 * when present → open → try → `finally close()`» was copied into ~14 files, and
 * seven times inside the daily-capture deps alone. Every copy was one chance to
 * forget the close (a leaked libSQL connection per request) or to spread a bare
 * `authToken: undefined` (which `exactOptionalPropertyTypes` rejects, so each
 * copy re-invented the same conditional). Here it is written once, so a new
 * call-site cannot forget either half, and telemetry or a retry would have a
 * single home.
 *
 * Scope safety (auditoría #1692): this opens the CONTROL PLANE — the single
 * global database that holds workspace rows, entitlements, meters and the
 * exposure catalog — never a workspace database. The per-request tenancy seam
 * stays exactly where it was (`store.ts` / `store-resolver.ts`): nothing here
 * resolves a target, and nothing here is cached or memoized, so one connection
 * is opened and closed per call and no state can survive into another request.
 * The narrow {@link ControlPlaneStore} is deliberate too — catalog curation
 * writes remain reachable only from `/admin`'s wider opener (#1123).
 */

import { type ControlPlaneStore, createControlPlaneStore } from "@worthline/db";

/** The env a control-plane opener reads. `process.env` unless a caller passes its own. */
export type ControlPlaneEnv = Readonly<Record<string, string | undefined>>;

/** The coordinates one control-plane connection needs. */
export interface ControlPlaneTarget {
  url: string;
  /** The group token, omitted (not undefined) when the env declares none. */
  authToken?: string;
}

/**
 * The control-plane coordinates `env` declares, or `null` when it declares none
 * — which is the ordinary local no-auth setup, not an error. Blank values read
 * as absent: a whitespace-only URL is not a configured control plane.
 */
export function controlPlaneTargetFromEnv(
  env: ControlPlaneEnv = process.env,
): ControlPlaneTarget | null {
  const url = env["WORTHLINE_CONTROL_PLANE_DB_URL"]?.trim();
  if (!url) return null;
  const authToken = env["WORTHLINE_DB_AUTH_TOKEN"]?.trim();
  return { url, ...(authToken ? { authToken } : {}) };
}

/**
 * The same coordinates for a caller that cannot work without them (provisioning,
 * the durable queue, the cron, billing) — it throws naming `purpose`, so the
 * message says which surface refused rather than just which variable is unset.
 */
export function requireControlPlaneTarget(
  purpose: string,
  env: ControlPlaneEnv = process.env,
): ControlPlaneTarget {
  const target = controlPlaneTargetFromEnv(env);
  if (!target) {
    throw new Error(`${purpose} requires WORTHLINE_CONTROL_PLANE_DB_URL.`);
  }
  return target;
}

export interface OpenControlPlaneOptions {
  /** Where to read the coordinates from. `process.env` by default. */
  env?: ControlPlaneEnv;
  /** Already-resolved coordinates — skips the env read entirely. */
  target?: ControlPlaneTarget;
  /** Named in the error when nothing is configured. */
  purpose?: string;
}

/**
 * Open a control-plane connection. The CALLER owns closing it — prefer
 * {@link withControlPlaneStore}, which cannot forget.
 */
export function openControlPlaneStore(
  options: OpenControlPlaneOptions = {},
): Promise<ControlPlaneStore> {
  const target =
    options.target ??
    requireControlPlaneTarget(options.purpose ?? "The control plane", options.env);
  return createControlPlaneStore(target);
}

export interface WithControlPlaneStoreOptions<S> extends OpenControlPlaneOptions {
  /**
   * A store the caller owns (tests, or a surface that already holds one): handed
   * to `run` as-is and never closed here, mirroring `admin-control-plane.ts`.
   */
  injectedStore?: S;
  /**
   * A caller-supplied opener — the injectable `openControlPlane` dep some
   * surfaces already publish (the durable queue, the impersonation lookup, the
   * reference session). Unlike `injectedStore`, the store it returns IS closed
   * here: the opener made the connection, so this helper owns its end.
   */
  open?: () => Promise<S & { close(): void }>;
}

/**
 * Open the control plane, hand it to `run`, and always close it.
 *
 * Generic over the port `S` the caller actually needs, like the `/admin` twin:
 * `run`'s parameter narrows to just that concern, so a call-site touches only
 * the methods it uses and a test can inject a fake of that single port. `S` is
 * constrained to a subset of {@link ControlPlaneStore}, so the opened store
 * (which implements every port) always satisfies it.
 */
export async function withControlPlaneStore<
  T,
  S extends Partial<ControlPlaneStore> = ControlPlaneStore,
>(
  run: (store: S) => T | Promise<T>,
  options: WithControlPlaneStoreOptions<S> = {},
): Promise<T> {
  if (options.injectedStore) {
    return run(options.injectedStore);
  }
  const store: S & { close(): void } = options.open
    ? await options.open()
    : ((await openControlPlaneStore(options)) as unknown as S & { close(): void });
  try {
    return await run(store);
  } finally {
    store.close();
  }
}

/**
 * {@link withControlPlaneStore} for the surfaces where an unconfigured control
 * plane is a legitimate state rather than a failure — the meters, the best-effort
 * marks, the reference readers. Resolves `null` WITHOUT opening anything when no
 * URL is configured (local no-auth dev is unmetered by design), and otherwise
 * behaves exactly like the strict helper. An open or run failure still throws:
 * how to degrade is the caller's call, not this module's.
 */
export async function withOptionalControlPlaneStore<
  T,
  S extends Partial<ControlPlaneStore> = ControlPlaneStore,
>(
  run: (store: S) => T | Promise<T>,
  options: { env?: ControlPlaneEnv } = {},
): Promise<T | null> {
  const target = controlPlaneTargetFromEnv(options.env);
  if (!target) return null;
  return withControlPlaneStore(run, { target });
}
