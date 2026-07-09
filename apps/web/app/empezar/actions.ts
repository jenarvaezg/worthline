"use server";

import { runActionWithStore, testStoreFromActionArgs } from "@web/action-store";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  SCOPE_COOKIE_NAME,
  errorRedirectUrl,
  parseEmpezarHogar,
  parseEmpezarSolo,
} from "@web/intake";
import { guardDemoWrite } from "@web/demo/write-guard";

export async function initSoloAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite("/empezar");
  const currentUrl = "/empezar?path=solo";
  const result = parseEmpezarSolo(formData);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(currentUrl, {
        message: result.error,
        formId: "solo",
        values: { name: String(formData.get("name") ?? "") },
      }),
    );
  }

  const { command } = result;

  await runActionWithStore(
    (store) => store.workspace.initializeWorkspace(command),
    _store,
  );

  const firstMemberId = command.members[0]?.id;

  if (firstMemberId) {
    const jar = await cookies();
    jar.set(SCOPE_COOKIE_NAME, firstMemberId, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
  }

  // S4 (#599): first run flows straight into the add wizard — one continuous
  // path, never a drop onto an empty dashboard.
  redirect("/patrimonio/anadir");
}

export async function initHogarAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite("/empezar");
  const currentUrl = "/empezar?path=hogar";
  const result = parseEmpezarHogar(formData);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(currentUrl, {
        message: result.error,
        formId: "hogar",
        values: { memberNames: String(formData.get("memberNames") ?? "") },
      }),
    );
  }

  const { command } = result;

  await runActionWithStore(
    (store) => store.workspace.initializeWorkspace(command),
    _store,
  );

  // Leave the scope cookie unset — the wizard falls back to the first scope.
  // S4 (#599): chain straight into the add wizard, not the empty dashboard.
  redirect("/patrimonio/anadir");
}
