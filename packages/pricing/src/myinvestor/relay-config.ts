/**
 * Where the MyInvestor relay lives (ADR 0114, decision 10). Every call to MyInvestor
 * leaves through a Cloudflare Worker (`apps/myinvestor-relay`), locked with a shared
 * secret. Both variables are set together or not at all: without them the connector
 * is off; with only one, or a malformed one, the server refuses to start.
 */

export const MYINVESTOR_RELAY_URL_ENV = "MYINVESTOR_RELAY_URL";
export const MYINVESTOR_RELAY_SECRET_ENV = "MYINVESTOR_RELAY_SECRET";

/** The same floor the relay's README asks for: 32 characters, e.g. `openssl rand -hex 32`. */
export const MYINVESTOR_RELAY_MIN_SECRET_LENGTH = 32;

export interface MyInvestorRelayConfig {
  /** The Worker's https URL; every call is a request to it. */
  readonly url: string;
  /** Sent in `x-relay-secret`; never logged nor put in an error. */
  readonly secret: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The relay configuration, `null` when the connector is off. Throws when half-set or malformed. */
export function readMyInvestorRelayConfig(env: Env): MyInvestorRelayConfig | null {
  const url = present(env[MYINVESTOR_RELAY_URL_ENV]);
  const secret = present(env[MYINVESTOR_RELAY_SECRET_ENV]);
  if (!url && !secret) return null;
  if (!url) {
    throw new Error(
      `${MYINVESTOR_RELAY_URL_ENV} must be set together with ${MYINVESTOR_RELAY_SECRET_ENV} (ADR 0114).`,
    );
  }
  if (!secret) {
    throw new Error(
      `${MYINVESTOR_RELAY_SECRET_ENV} must be set together with ${MYINVESTOR_RELAY_URL_ENV} (ADR 0114).`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${MYINVESTOR_RELAY_URL_ENV} is not a URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `${MYINVESTOR_RELAY_URL_ENV} must be https: the relay carries passwords and tokens.`,
    );
  }
  if (secret.length < MYINVESTOR_RELAY_MIN_SECRET_LENGTH) {
    throw new Error(
      `${MYINVESTOR_RELAY_SECRET_ENV} must have at least ${MYINVESTOR_RELAY_MIN_SECRET_LENGTH} characters.`,
    );
  }
  return { url: parsed.toString(), secret };
}

/** The relay configuration where the connector runs: off is a misconfiguration there. */
export function requireMyInvestorRelayConfig(env: Env): MyInvestorRelayConfig {
  const config = readMyInvestorRelayConfig(env);
  if (!config) {
    throw new Error(
      `${MYINVESTOR_RELAY_URL_ENV} and ${MYINVESTOR_RELAY_SECRET_ENV} are not set: the MyInvestor connector is off.`,
    );
  }
  return config;
}
