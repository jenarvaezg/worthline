/**
 * The daily provisioning cap, read from the deployment (#1175, PRD #1171 S4).
 *
 * The figure is an operational decision kept in the maintainer's plan, outside
 * the public repo — so this module knows its NAME and nothing about its value:
 * there is no default number anywhere in code, docs or tests.
 *
 * Unset means **no cap**. Registration is open by design (#733): local no-auth
 * dev, the e2e suite and any self-hosted deploy never provision through a fuse,
 * and a missing variable must not turn into «nobody can sign up» — a silent,
 * total outage of the front door would be worse than the cost the fuse bounds.
 * The fuse is something the operator switches ON.
 *
 * A value that is set but is not a non-negative integer is the opposite case:
 * the operator clearly meant to switch the fuse on, so a typo must not quietly
 * remove it. It fails CLOSED — for new workspaces only; a returning user is
 * resolved before the cap is consulted — and the maintainer alert names the
 * misconfiguration, so the first refused sign-up is also the signal to fix it.
 *
 * Pure over an env bag: no `process.env` read, no I/O.
 */

/** The env var the deployment sets the cap with. */
export const DAILY_PROVISIONING_CAP_ENV = "WORTHLINE_DAILY_PROVISIONING_CAP";

/**
 * The query flag a refused sign-up carries back to the login page, which reads
 * it and says «hoy estamos llenos, vuelve mañana».
 */
export const PROVISIONING_CLOSED_FLAG = { name: "registro", value: "lleno" } as const;

/**
 * Where a refused sign-up lands (#1175). Same-origin and relative, so Auth.js's
 * redirect callback accepts it as is.
 */
export const PROVISIONING_CLOSED_LOGIN_PATH = `/login?${PROVISIONING_CLOSED_FLAG.name}=${PROVISIONING_CLOSED_FLAG.value}`;

export type DailyProvisioningCapPolicy =
  | { kind: "uncapped" }
  | { kind: "capped"; cap: number }
  | { kind: "misconfigured"; raw: string };

/** Digits only: no sign, no decimals, no exponent, no hex, no separators. */
const NON_NEGATIVE_INTEGER = /^\d+$/;

export function readDailyProvisioningCap(
  env: Readonly<Record<string, string | undefined>>,
): DailyProvisioningCapPolicy {
  const raw = env[DAILY_PROVISIONING_CAP_ENV];
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return { kind: "uncapped" };
  if (!NON_NEGATIVE_INTEGER.test(trimmed)) {
    return { kind: "misconfigured", raw: raw ?? "" };
  }
  const cap = Number(trimmed);
  return Number.isSafeInteger(cap)
    ? { cap, kind: "capped" }
    : { kind: "misconfigured", raw: raw ?? "" };
}

/**
 * The cap the provisioner enforces: null for none, a number otherwise. A
 * misconfigured value closes registration (cap 0) — see the module contract.
 */
export function effectiveDailyProvisioningCap(
  policy: DailyProvisioningCapPolicy,
): number | null {
  switch (policy.kind) {
    case "uncapped":
      return null;
    case "capped":
      return policy.cap;
    case "misconfigured":
      return 0;
  }
}
