"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  SCOPE_COOKIE_NAME,
  errorRedirectUrl,
  parseEmpezarHogar,
  parseEmpezarSolo,
} from "../intake";

export async function initSoloAction(
  formData: FormData,
  _store?: WorthlineStore,
): Promise<never> {
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
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  runWith((store) => store.workspace.initializeWorkspace(command));

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
  const runWith = <T>(fn: (store: WorthlineStore) => T): T =>
    _store ? fn(_store) : withStore(fn);

  runWith((store) => store.workspace.initializeWorkspace(command));

  // Leave the scope cookie unset — / will fall back to the first scope.
  redirect("/");
}
