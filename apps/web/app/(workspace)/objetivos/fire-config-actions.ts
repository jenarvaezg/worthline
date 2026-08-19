"use server";

import { actionScopeExists, INVALID_SCOPE_MESSAGE } from "@web/action-scope";
import { formAction } from "@web/form-action";
import {
  appendParam,
  errorRedirectUrl,
  localRedirectPath,
  parseFireConfigFormStrict,
} from "@web/intake";

/**
 * Where a save lands when the form's `currentUrl` is missing or not local. It is
 * /objetivos, never /ajustes: the fallback of the action that moved cannot send the
 * user back to the screen the form moved OUT of (#1450).
 */
const currentUrlOf = (formData: FormData): string =>
  localRedirectPath(String(formData.get("currentUrl") ?? ""), "/objetivos");

/**
 * Saving the FIRE assumptions, from the screen that shows them (#1450).
 *
 * The action moved here with its form: /ajustes no longer owns the FIRE config, so
 * the write and the surface that offers it live together. The redirect follows
 * `currentUrl`, which is now /objetivos — the user lands back on the figures the
 * save just moved, not on a settings page they had to leave to see the effect.
 */
export const saveFireConfigAction = formAction({
  requireId: false,
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  parse: ({ formData }) => {
    const scopeId = String(formData.get("scopeId") ?? "").trim() || "household";
    const result = parseFireConfigFormStrict(formData);
    if (!result.ok) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          message: result.error,
          formId: "fire",
        }),
      };
    }
    return { ok: true, value: { scopeId, command: result.command } };
  },
  run: async (store, { parsed }) => {
    if (!(await actionScopeExists(store, parsed.scopeId))) {
      return { ok: false, error: INVALID_SCOPE_MESSAGE };
    }
    await store.saveFireConfig(parsed.scopeId, parsed.command);
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error, formId: "fire" }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "fire_saved"),
});
