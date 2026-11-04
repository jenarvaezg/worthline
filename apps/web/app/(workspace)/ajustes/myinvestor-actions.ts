"use server";

/**
 * Server actions of the MyInvestor connection (#1879, PRD #1876). ADR 0043 keeps
 * each source's lifecycle in its own module; the steps live in
 * `myinvestor-connect.ts` and these actions only wire them and pick the terminal.
 *
 * Every action that writes passes the write guard FIRST (a viewer, the demo and an
 * impersonating admin are refused before the store is opened, ADR del viewer (#1843)). The ones
 * that talk to MyInvestor also pass the premium gate (ADR 0114 decision 2) and
 * need the relay (decision 10). Forgetting the password and disconnecting do not:
 * deleting a secret is never premium.
 *
 * The connect fold is two steps in ONE fold, so its actions answer as state
 * (`useActionState`): a refusal and «MyInvestor sent an SMS» stay in the fold, and
 * only a finished connection redirects (interaction-patterns §4.1). The password is
 * never put in a URL nor returned in a state.
 */

import { randomUUID } from "node:crypto";
import {
  isClock,
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite, isWriteBlocked } from "@web/demo/write-guard";
import { ingestionBlockedMessage } from "@web/entitlements/ingestion-guard";
import {
  PAYWALL_CONNECT_SOURCE_MESSAGE,
  PAYWALL_SOURCES_PAUSED_MESSAGE,
} from "@web/entitlements/paywall-copy";
import {
  type FormActionState,
  formAction,
  formActionInlineError,
} from "@web/form-action";
import { appendParam, errorRedirectUrl, parseEntityId } from "@web/intake";
import { readSessionEmail } from "@web/read-store-target";
import type { WorthlineStore } from "@web/store";
import { systemClock } from "@worthline/domain";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  MYINVESTOR_DISCONNECT_FORM_ID,
  MYINVESTOR_PASSWORD_FORM_ID,
} from "./connected-source-form-ids";
import { currentUrlOf } from "./connected-source-helpers";
import {
  forgetMyInvestorPassword,
  type MyInvestorFlowDeps,
  type MyInvestorStep,
  saveMyInvestorPassword,
  startMyInvestorConnect,
  submitMyInvestorCode,
} from "./myinvestor-connect";
import {
  MYINVESTOR_ACCEPTANCE_TEXT,
  MYINVESTOR_NOT_FOUND,
  MYINVESTOR_PENDING_EXPIRED,
  MYINVESTOR_UNAVAILABLE_LINE,
} from "./myinvestor-copy";
import { parseMyInvestorCode, parseMyInvestorLogin } from "./myinvestor-credentials";
import type { MyInvestorFormState } from "./myinvestor-form-state";
import {
  isMyInvestorClientOverride,
  type MyInvestorClientFactory,
  myInvestorClientFactory,
} from "./myinvestor-relay";

const CODE_NOT_A_CODE = "Escribe el código del SMS: solo cifras.";

interface FrontMatter {
  store: WorthlineStore | undefined;
  now: string;
  clientFor: MyInvestorClientFactory | null;
}

/** The test seams (store, clock, client) and the write guard, in that order. */
async function frontMatter(
  formData: FormData,
  testArgs: readonly unknown[],
): Promise<FrontMatter> {
  const store = testStoreFromActionArgs(testArgs);
  const clock = testArgFromActionArgs(testArgs, isClock) ?? systemClock();
  const override = testArgFromActionArgs(testArgs, isMyInvestorClientOverride);
  // Throws Next's redirect for a viewer, the demo or an impersonating admin.
  await guardDemoWrite(currentUrlOf(formData));
  return {
    clientFor: override?.myInvestorClientFor ?? myInvestorClientFactory(),
    now: clock.now(),
    store,
  };
}

function flowDeps(
  store: WorthlineStore,
  front: FrontMatter,
  clientFor: MyInvestorClientFactory,
  acceptedBy: string | null,
): MyInvestorFlowDeps {
  return {
    acceptedBy,
    clientFor,
    newDeviceId: randomUUID,
    now: front.now,
    store: store.connectedSources,
  };
}

/** A connection made redirects to its row; any other step stays in the fold. */
function terminal(
  step: MyInvestorStep,
  formData: FormData,
  customerId?: string,
): MyInvestorFormState {
  if (step.step === "connected") {
    // Same router-cache invalidation as every other successful mutation (#1191).
    revalidatePath("/", "layout");
    redirect(appendParam(currentUrlOf(formData), "ok", "myinvestor_connected"));
  }
  if (step.step === "sms") return step;
  return customerId === undefined ? step : { ...step, customerId };
}

/** Step 1 of the connect fold: username, password and the box. */
export async function startMyInvestorConnectAction(
  _prevState: MyInvestorFormState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<MyInvestorFormState> {
  const front = await frontMatter(formData, _testArgs);

  const paywall = await ingestionBlockedMessage(PAYWALL_CONNECT_SOURCE_MESSAGE);
  if (paywall) return { error: paywall, step: "credentials" };
  const clientFor = front.clientFor;
  if (!clientFor) return { error: MYINVESTOR_UNAVAILABLE_LINE, step: "credentials" };

  const parsed = parseMyInvestorLogin(formData);
  const customerId = String(formData.get("customerId") ?? "").trim();
  if (!parsed.ok) return { customerId, error: parsed.error, step: "credentials" };

  const acceptedBy = parsed.value.save ? await readSessionEmail() : null;
  const step = await runActionWithStore(
    (store) =>
      startMyInvestorConnect(flowDeps(store, front, clientFor, acceptedBy), parsed.value),
    front.store,
  );
  return terminal(step, formData, customerId);
}

/** Step 2 of the connect fold: the SMS code. */
export async function submitMyInvestorCodeAction(
  prevState: MyInvestorFormState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<MyInvestorFormState> {
  const front = await frontMatter(formData, _testArgs);

  const paywall = await ingestionBlockedMessage(PAYWALL_CONNECT_SOURCE_MESSAGE);
  if (paywall) return { error: paywall, step: "credentials" };
  const clientFor = front.clientFor;
  if (!clientFor) return { error: MYINVESTOR_UNAVAILABLE_LINE, step: "credentials" };

  const pendingId = parseEntityId(formData, "pendingId");
  if (!pendingId) return { error: MYINVESTOR_PENDING_EXPIRED, step: "credentials" };
  const code = parseMyInvestorCode(formData);
  if (!code) {
    // The previous state only dresses the refusal (the time it expires); whether
    // the step is still alive is the database's call on the next submit.
    return prevState.step === "sms"
      ? { ...prevState, error: CODE_NOT_A_CODE }
      : { error: MYINVESTOR_PENDING_EXPIRED, step: "credentials" };
  }

  // Who accepts is resolved now, but only the opt-in in the pending step uses it:
  // the acceptance was recorded with the box, in step 1.
  const step = await runActionWithStore(
    (store) =>
      submitMyInvestorCode(flowDeps(store, front, clientFor, null), {
        code,
        pendingId,
      }),
    front.store,
  );
  // A wrong code keeps the masked destination the first answer showed.
  if (step.step === "sms" && prevState.step === "sms" && step.destination === null) {
    return terminal({ ...step, destination: prevState.destination }, formData);
  }
  return terminal(step, formData);
}

/**
 * «Empezar de nuevo»: the fold goes back to step 1 in the browser at once, and the
 * pending step — with the credentials it may hold — is deleted here instead of
 * waiting to be replaced. Fired from the client without a navigation, so a blocked
 * write is refused silently rather than with a redirect.
 */
export async function cancelMyInvestorCodeAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<void> {
  if (await isWriteBlocked()) return;
  const pendingId = parseEntityId(formData, "pendingId");
  if (!pendingId) return;
  await runActionWithStore(
    (store) => store.connectedSources.deletePendingLogin(pendingId),
    testStoreFromActionArgs(_testArgs),
  );
}

function passwordErrorUrl(formData: FormData, message: string): string {
  return errorRedirectUrl(currentUrlOf(formData), {
    formId: MYINVESTOR_PASSWORD_FORM_ID,
    message,
  });
}

/**
 * Remember the password on a connected row (ADR 0114 decision 1). The box must be
 * ticked — that is the acceptance — and MyInvestor must accept the password on the
 * device it already trusts. Nothing is written otherwise.
 */
export async function saveMyInvestorPasswordAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<FormActionState> {
  const override = testArgFromActionArgs(_testArgs, isMyInvestorClientOverride);
  // Success redirects; a rejection comes back as state inside the fold when the
  // island asks for it (`inlineError=1`), and redirects only without JS (§4.1).
  const action = formActionInlineError<{ customerId: string; password: string }>({
    datedFact: false,
    extraIds: ["sourceId"],
    guardUrl: currentUrlOf,
    missingId: MYINVESTOR_NOT_FOUND,
    missingIdUrl: currentUrlOf,
    parse: ({ formData: data }) => {
      if (data.get("acceptRisk") !== "on") {
        return {
          error: `Para guardarla, marca la casilla: «${MYINVESTOR_ACCEPTANCE_TEXT}»`,
          ok: false,
        };
      }
      const parsed = parseMyInvestorLogin(data);
      return parsed.ok
        ? {
            ok: true,
            value: {
              customerId: parsed.value.customerId,
              password: parsed.value.password,
            },
          }
        : { error: parsed.error, ok: false };
    },
    requireId: false,
    run: async (store, { extra, now, parsed }) => {
      // It talks to MyInvestor, so a lapsed plan refuses it like any sync (#1162).
      const paywall = await ingestionBlockedMessage(PAYWALL_SOURCES_PAUSED_MESSAGE);
      if (paywall) return { error: paywall, ok: false };
      const clientFor = override?.myInvestorClientFor ?? myInvestorClientFactory();
      if (!clientFor) return { error: MYINVESTOR_UNAVAILABLE_LINE, ok: false };
      return saveMyInvestorPassword(
        {
          acceptedBy: await readSessionEmail(),
          clientFor,
          newDeviceId: randomUUID,
          now,
          store: store.connectedSources,
        },
        { ...parsed, sourceId: extra.sourceId! },
      );
    },
    onError: ({ error }) => ({ error }),
    onErrorUrl: ({ formData: data, error }) => passwordErrorUrl(data, error),
    onSuccess: ({ formData: data }) =>
      appendParam(currentUrlOf(data), "ok", "myinvestor_password_saved"),
  });
  return action(formData, ..._testArgs);
}

/** «Dejar de guardarla»: the password is deleted at once; the device stays. */
export const forgetMyInvestorPasswordAction = formAction({
  datedFact: false,
  extraIds: ["sourceId"],
  guardUrl: currentUrlOf,
  missingId: MYINVESTOR_NOT_FOUND,
  missingIdUrl: currentUrlOf,
  requireId: false,
  run: (store, { extra }) =>
    forgetMyInvestorPassword({ store: store.connectedSources }, extra.sourceId!),
  onError: ({ formData, error }) => passwordErrorUrl(formData, error),
  onSuccess: ({ formData }) =>
    appendParam(currentUrlOf(formData), "ok", "myinvestor_password_forgotten"),
});

/**
 * Disconnect MyInvestor (ADR 0115 decision 6): the credentials go at once, and each
 * linked holding stays as manual with its operations.
 */
export const disconnectMyInvestorAction = formAction({
  datedFact: false,
  extraIds: ["sourceId"],
  guardUrl: currentUrlOf,
  missingId: MYINVESTOR_NOT_FOUND,
  missingIdUrl: currentUrlOf,
  requireId: false,
  run: async (store, { extra }) => {
    const result = await store.connectedSources.disconnectOwningSource(extra.sourceId!);
    return result ? { ok: true } : { error: MYINVESTOR_NOT_FOUND, ok: false };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), {
      formId: MYINVESTOR_DISCONNECT_FORM_ID,
      message: error,
    }),
  onSuccess: ({ formData }) =>
    appendParam(currentUrlOf(formData), "ok", "myinvestor_disconnected"),
});
