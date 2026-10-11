import type { DailyProvisioningCapPolicy } from "@worthline/db";

/**
 * The daily provisioning cap, read from the deployment (#1175, PRD #1171 S4).
 *
 * The figure is an operational decision kept in the maintainer's plan, outside
 * the public repo — so this module knows its NAME and nothing about its value:
 * there is no default number anywhere in code, docs or tests.
 *
 * What an absent variable means depends on where the app runs:
 *
 * - **Outside production** (local no-auth dev, the e2e suite, a self-hosted
 *   deploy) it means no cap: registration is open by design there (#733), and
 *   none of those provisions billed databases for strangers.
 * - **In a Vercel production deploy** it closes new sign-ups, exactly like an
 *   unreadable value. The fuse exists to close #733's open registration in the
 *   public deploy (PRD #1171), and a variable forgotten in the Vercel dashboard
 *   must not reopen it in silence — so a forgotten variable and a typo behave
 *   the same, and the maintainer alert names which one it was.
 *
 * Neither ever touches an existing user: the provisioner resolves them before
 * the cap is consulted. That is also why this is not a boot refusal in
 * `production-config.ts` — refusing to boot would lock out everyone.
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

/** Digits only: no sign, no decimals, no exponent, no hex, no separators. */
const NON_NEGATIVE_INTEGER = /^\d+$/;

/**
 * The same production signal `production-config.ts` keys on: `VERCEL_ENV` is set
 * only by the hosted platform, while `NODE_ENV=production` is also how local
 * single-user mode and the e2e suite run.
 */
function isProductionDeploy(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["VERCEL_ENV"]?.trim() === "production";
}

export function readDailyProvisioningCap(
  env: Readonly<Record<string, string | undefined>>,
): DailyProvisioningCapPolicy {
  const configuredValue = env[DAILY_PROVISIONING_CAP_ENV] ?? "";
  const trimmed = configuredValue.trim();
  if (trimmed === "") {
    return isProductionDeploy(env) ? { kind: "unset" } : { kind: "uncapped" };
  }
  const limit = Number(trimmed);
  return NON_NEGATIVE_INTEGER.test(trimmed) && Number.isSafeInteger(limit)
    ? { kind: "limited", limit }
    : { configuredValue, kind: "misconfigured" };
}
