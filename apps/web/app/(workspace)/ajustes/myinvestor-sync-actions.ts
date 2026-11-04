"use server";

/**
 * «Poner al día» of MyInvestor, the server action (#1884, ADR 0114 decision 4):
 * the button of the ficha's panel and of the MyInvestor row of Conexiones, and the
 * panel's «Resincronizar todo». The pass is `runMyInvestorSync`; this only wires
 * it and words its result.
 *
 * - The write guard first (a viewer, the demo, an impersonating admin), then the
 *   premium gate (decision 2) and the relay (decision 10).
 * - The result comes back as state (`useActionState`): the panel shows it where
 *   the steps were, and a refusal stays beside the button (interaction-patterns
 *   §4.1). A pass that ran, good or not, revalidates: the band and the figures
 *   read the state it left.
 * - The password typed when none is saved is used for this pass and never kept;
 *   it is never put in a URL nor returned in a state.
 */
import { PAYWALL_SOURCES_PAUSED_MESSAGE } from "@web/entitlements/paywall-copy";
import { type FormActionState, formActionState } from "@web/form-action";
import type { MyInvestorCredentials } from "@worthline/pricing";
import { currentUrlOf } from "./connected-source-helpers";
import { myInvestorClientOrRefusal } from "./myinvestor-action-preamble";
import { MYINVESTOR_NOT_FOUND } from "./myinvestor-copy";
import { elapsedClock, runMyInvestorSync } from "./myinvestor-sync";
import { type MyInvestorResultView, myInvestorResultView } from "./myinvestor-sync-view";

export type MyInvestorSyncFormState = FormActionState<MyInvestorResultView>;

interface SyncRequest {
  typed: MyInvestorCredentials | null;
  fullHistory: boolean;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ponerAlDiaMyInvestorAction(
  prevState: MyInvestorSyncFormState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<MyInvestorSyncFormState> {
  const action = formActionState<SyncRequest, MyInvestorResultView>({
    datedFact: false,
    extraIds: ["sourceId"],
    guardUrl: currentUrlOf,
    missingId: MYINVESTOR_NOT_FOUND,
    parse: ({ formData: data }) => {
      const customerId = String(data.get("customerId") ?? "").trim();
      const password = String(data.get("password") ?? "");
      return {
        ok: true,
        value: {
          fullHistory: data.get("fullHistory") === "1",
          typed: customerId && password ? { customerId, password } : null,
        },
      };
    },
    requireId: false,
    run: async (store, { extra, now, parsed, today }) => {
      const client = await myInvestorClientOrRefusal(
        PAYWALL_SOURCES_PAUSED_MESSAGE,
        _testArgs,
      );
      if (!client.ok) return client;

      const result = await runMyInvestorSync(
        {
          clientFor: client.clientFor,
          now: elapsedClock(now),
          sleep: wait,
          store,
          today: () => today,
        },
        {
          fullHistory: parsed.fullHistory,
          sourceId: extra.sourceId!,
          trigger: "manual",
          typed: parsed.typed,
        },
      );
      const view = myInvestorResultView(result, now);
      if (result.status === "done") return { ok: true, ...view };
      return {
        error: view.blockedLine ? `${view.text} ${view.blockedLine}` : view.text,
        ok: false,
      };
    },
  });
  return action(prevState, formData, ..._testArgs);
}
