/**
 * Where the MyInvestor client comes from in a request (#1879, ADR 0114 decision
 * 10): every call leaves through the Cloudflare relay, so without its two env
 * variables there is no client and the «Sin conectar» row offers no fold. A half-set
 * pair never gets this far: `instrumentation.ts` refuses to boot with one.
 *
 * Read per request, never at module scope or in a prerendered shell: the env of
 * the build is not the env of the server (a page reading it must call
 * `connection()` first).
 */
import {
  createMyInvestorClient,
  createRelayTransport,
  readMyInvestorRelayConfig,
} from "@worthline/pricing";
import type { MyInvestorConnectClient } from "./myinvestor-connect";

/** A client bound to a device, or null when the relay is not configured. */
export type MyInvestorClientFactory = (deviceId: string) => MyInvestorConnectClient;

export function isMyInvestorRelayConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return readMyInvestorRelayConfig(env) !== null;
}

export function myInvestorClientFactory(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MyInvestorClientFactory | null {
  const config = readMyInvestorRelayConfig(env);
  if (!config) return null;
  const transport = createRelayTransport(config);
  return (deviceId) => createMyInvestorClient({ deviceId, transport });
}

/**
 * The test seam of the actions: a test hands in `{ myInvestorClientFor }` so no
 * request ever reaches the relay. Wrapped in an object so the predicate cannot
 * mistake another injected callback for it.
 */
export function isMyInvestorClientOverride(
  value: unknown,
): value is { myInvestorClientFor: MyInvestorClientFactory } {
  return typeof value === "object" && value !== null && "myInvestorClientFor" in value;
}
