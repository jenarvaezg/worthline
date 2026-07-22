"use server";

import { markOnboardedBestEffort } from "@web/activation-marks";
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
      // The workspace completed /empezar — stamp the set-once mark (#1131).
      await markOnboardedBestEffort();
    },
    // parse builds the full redirect URL on failure; run never returns { ok: false }.
    onError: () => "/empezar",
    // S4 (#599): first run flows straight into the add wizard — one continuous
    // path, never a drop onto an empty dashboard.
    onSuccess: () => "/patrimonio/anadir",
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
    // The workspace completed /empezar — stamp the set-once mark (#1131).
    afterCommit: async () => {
      await markOnboardedBestEffort();
    },
    // parse builds the full redirect URL on failure; run never returns { ok: false }.
    onError: () => "/empezar",
    // S4 (#599): chain straight into the add wizard, not the empty dashboard.
    onSuccess: () => "/patrimonio/anadir",
  })(formData, ..._testArgs);
}
