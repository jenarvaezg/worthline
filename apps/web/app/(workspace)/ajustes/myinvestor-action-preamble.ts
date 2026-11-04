/**
 * What every server action that talks to MyInvestor checks before it does (#1876):
 * the premium gate (ADR 0114 decision 2; a lapsed plan refuses it like any sync,
 * #1162) and the relay it talks through (decision 10). Out of the `"use server"`
 * modules on purpose: an exported async function there would be an action of its
 * own.
 */
import { testArgFromActionArgs } from "@web/action-store";
import { ingestionBlockedMessage } from "@web/entitlements/ingestion-guard";
import { MYINVESTOR_UNAVAILABLE_LINE } from "./myinvestor-copy";
import {
  isMyInvestorClientOverride,
  type MyInvestorClientFactory,
  myInvestorClientFactory,
} from "./myinvestor-relay";

export type MyInvestorClientOrRefusal =
  | { readonly ok: true; readonly clientFor: MyInvestorClientFactory }
  | { readonly ok: false; readonly error: string };

/**
 * The client factory, or the refusal in the user's words: the paywall's
 * `paywallMessage` first, then the relay that is not configured. The test seam
 * (`myInvestorClientFor` among the action's test args) stands in for the relay.
 */
export async function myInvestorClientOrRefusal(
  paywallMessage: string,
  testArgs: readonly unknown[],
): Promise<MyInvestorClientOrRefusal> {
  const paywall = await ingestionBlockedMessage(paywallMessage);
  if (paywall) return { error: paywall, ok: false };
  const override = testArgFromActionArgs(testArgs, isMyInvestorClientOverride);
  const clientFor = override?.myInvestorClientFor ?? myInvestorClientFactory();
  return clientFor
    ? { clientFor, ok: true }
    : { error: MYINVESTOR_UNAVAILABLE_LINE, ok: false };
}
