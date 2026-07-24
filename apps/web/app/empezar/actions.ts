"use server";

import { formAction } from "@web/form-action";
import {
  errorRedirectUrl,
  parseEmpezarHogar,
  parseEmpezarSolo,
  SCOPE_COOKIE_NAME,
  type WorkspaceInitCommand,
} from "@web/intake";
import { cookies } from "next/headers";

export async function initSoloAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<WorkspaceInitCommand, { firstMemberId: string | undefined }>({
    requireId: false,
    datedFact: false,
    guardUrl: () => "/empezar",
    parse: ({ formData }) => {
      const result = parseEmpezarSolo(formData);
      if (!result.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl("/empezar?path=solo", {
            message: result.error,
            formId: "solo",
            values: { name: String(formData.get("name") ?? "") },
          }),
        };
      }
      return { ok: true, value: result.command };
    },
    run: async (store, { parsed }) => {
      await store.workspace.initializeWorkspace(parsed);
      return { ok: true, value: { firstMemberId: parsed.members[0]?.id } };
    },
    afterCommit: async ({ value }) => {
      if (value?.firstMemberId) {
        const jar = await cookies();
        jar.set(SCOPE_COOKIE_NAME, value.firstMemberId, {
          httpOnly: true,
          path: "/",
          sameSite: "lax",
        });
      }
      // No onboarded mark here (#1168): declaring who you are is not onboarding.
      // The full-screen onboarding owns `onboarded_at` — it is stamped when the
      // workspace completes onboarding («lo haré luego» or its first holding).
    },
    // parse builds the full redirect URL on failure; run never returns { ok: false }.
    onError: () => "/empezar",
    // Post-registration lands on the full-screen onboarding (#1168), which
    // replaces the drop onto the manual add wizard as the first-run surface.
    onSuccess: () => "/bienvenida",
  })(formData, ..._testArgs);
}

export async function initHogarAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<WorkspaceInitCommand>({
    requireId: false,
    datedFact: false,
    guardUrl: () => "/empezar",
    parse: ({ formData }) => {
      const result = parseEmpezarHogar(formData);
      if (!result.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl("/empezar?path=hogar", {
            message: result.error,
            formId: "hogar",
            values: { memberNames: String(formData.get("memberNames") ?? "") },
          }),
        };
      }
      return { ok: true, value: result.command };
    },
    run: async (store, { parsed }) => {
      // Leave the scope cookie unset — the wizard falls back to the first scope.
      await store.workspace.initializeWorkspace(parsed);
      return { ok: true };
    },
    // parse builds the full redirect URL on failure; run never returns { ok: false }.
    onError: () => "/empezar",
    // Post-registration lands on the full-screen onboarding (#1168); onboarding
    // owns the `onboarded_at` mark, so /empezar no longer stamps it.
    onSuccess: () => "/bienvenida",
  })(formData, ..._testArgs);
}
