"use server";

import { withStore, type WorthlineStore } from "@web/store";
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
  _store?: WorthlineStore,
): Promise<never> {
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
  const runWith = <T>(fn: (store: WorthlineStore) => T | Promise<T>): Promise<T> =>
    _store ? Promise.resolve(fn(_store)) : withStore(fn);

  await runWith((store) => store.workspace.initializeWorkspace(command));

  const firstMemberId = command.members[0]?.id;

  if (firstMemberId) {
    const jar = await cookies();
    jar.set(SCOPE_COOKIE_NAME, firstMemberId, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
  }

  redirect("/");
}

export async function initHogarAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
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
  const runWith = <T>(fn: (store: WorthlineStore) => T | Promise<T>): Promise<T> =>
    _store ? Promise.resolve(fn(_store)) : withStore(fn);

  await runWith((store) => store.workspace.initializeWorkspace(command));

  // Leave the scope cookie unset — / will fall back to the first scope.
  redirect("/");
}
