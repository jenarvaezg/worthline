"use server";

/**
 * «Dar acceso» and «Quitar acceso» (#1844, S4 of #1718, ADR 0112): the owner
 * gives a read-only view of their workspace to another identity, and takes it
 * back, from /ajustes.
 *
 * Both are thin bindings of the S1 commands (`shareWorkspaceReadOnly`,
 * `revokeWorkspaceReadOnly`) called with the SESSION's email: the workspace is
 * resolved from the owner's own grant, never from the form, so a crafted POST can
 * only ever share the poster's own workspace.
 *
 * Built on `formActionInlineError`, for two reasons:
 *  - its front matter runs the write guard, so the demo, an admin impersonating
 *    and a viewer are turned away before the control plane is touched — the
 *    sharing controls are never rendered for them, and this is what refuses a
 *    direct POST;
 *  - a refusal comes back as state when the submit asks for it (the terminal that
 *    cannot be lost, interaction-patterns §4.1), so the optimistic row can revert
 *    and say why, and as a redirect back to the form without JavaScript.
 *
 * The combinator's store cycle opens the workspace store, which neither command
 * reads: the price of passing through the one gate every mutation shares.
 */

import { testArgFromActionArgs } from "@web/action-store";
import { actsOnOwnAccount } from "@web/demo/write-guard";
import { type FormActionState, formActionInlineError } from "@web/form-action";
import { appendParam, errorRedirectUrl } from "@web/intake";
import { readSessionEmail, readStoreTarget } from "@web/read-store-target";
import {
  READ_ONLY_ACCESS_FORM_ID,
  REVOKE_FAILURE_MESSAGE,
  SHARE_FAILURE_MESSAGE,
  shareRefusalMessage,
} from "@web/sharing/read-only-sharing";
import {
  isSharingPortsOverride,
  withSharingPorts,
} from "@web/sharing/sharing-control-plane";
import {
  revokeWorkspaceReadOnly,
  ShareWorkspaceRefusedError,
  shareWorkspaceReadOnly,
} from "@worthline/db";

/** Where both actions return: the settings page the section lives on. */
const AJUSTES_URL = "/ajustes";

/** Said when the request is not an owner acting on their own account. */
const OWN_ACCOUNT_ONLY_MESSAGE = "Solo quien es dueño de un espacio puede compartirlo.";

/**
 * The session's email when it acts on its own account, or null. The guard has
 * already refused every read-only session; what remains to refuse here is a
 * session with no account to share from — local no-auth mode.
 */
async function ownerEmailOfSession(): Promise<string | null> {
  if (!actsOnOwnAccount(await readStoreTarget())) return null;
  return readSessionEmail();
}

export async function shareReadOnlyAccessAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<FormActionState> {
  const injected = testArgFromActionArgs(_testArgs, isSharingPortsOverride)?.sharingPorts;

  return formActionInlineError<undefined, undefined>({
    datedFact: false,
    guardUrl: () => AJUSTES_URL,
    requireId: false,
    run: async (_store, { formData: fd }) => {
      const ownerEmail = await ownerEmailOfSession();
      if (!ownerEmail) return { error: OWN_ACCOUNT_ONLY_MESSAGE, ok: false };

      const viewerEmail = String(fd.get("viewerEmail") ?? "");
      try {
        const shared = await withSharingPorts(
          (ports) => shareWorkspaceReadOnly(ports, { ownerEmail, viewerEmail }),
          injected,
        );
        // The door is idempotent; to the owner who typed it, a second share of
        // the same person is a mistake worth saying.
        return shared.created
          ? { ok: true }
          : { error: shareRefusalMessage("already-granted"), ok: false };
      } catch (error) {
        if (error instanceof ShareWorkspaceRefusedError) {
          return { error: shareRefusalMessage(error.reason), ok: false };
        }
        console.error("sharing: giving read-only access failed", error);
        return { error: SHARE_FAILURE_MESSAGE, ok: false };
      }
    },
    // What was typed comes back, so a refusal never makes the owner retype it.
    onError: ({ error, formData: fd }) => ({
      error,
      values: { viewerEmail: String(fd.get("viewerEmail") ?? "") },
    }),
    onErrorUrl: ({ error, formData: fd }) =>
      errorRedirectUrl(AJUSTES_URL, {
        formId: READ_ONLY_ACCESS_FORM_ID,
        message: error,
        values: { viewerEmail: String(fd.get("viewerEmail") ?? "") },
      }),
    onSuccess: () => appendParam(AJUSTES_URL, "ok", "read_only_access_granted"),
  })(formData, ..._testArgs);
}

export async function revokeReadOnlyAccessAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<FormActionState> {
  const injected = testArgFromActionArgs(_testArgs, isSharingPortsOverride)?.sharingPorts;

  return formActionInlineError<undefined, undefined>({
    datedFact: false,
    guardUrl: () => AJUSTES_URL,
    requireId: false,
    run: async (_store, { formData: fd }) => {
      const ownerEmail = await ownerEmailOfSession();
      if (!ownerEmail) return { error: OWN_ACCOUNT_ONLY_MESSAGE, ok: false };

      const viewerUserId = String(fd.get("viewerUserId") ?? "").trim();
      if (!viewerUserId) return { error: REVOKE_FAILURE_MESSAGE, ok: false };
      try {
        // False means the person no longer had access — the state the owner
        // asked for, so it is not a refusal.
        await withSharingPorts(
          (ports) => revokeWorkspaceReadOnly(ports, { ownerEmail, viewerUserId }),
          injected,
        );
        return { ok: true };
      } catch (error) {
        console.error("sharing: taking read-only access back failed", error);
        return { error: REVOKE_FAILURE_MESSAGE, ok: false };
      }
    },
    onError: ({ error }) => ({ error }),
    onErrorUrl: ({ error }) =>
      errorRedirectUrl(AJUSTES_URL, { formId: READ_ONLY_ACCESS_FORM_ID, message: error }),
    onSuccess: () => appendParam(AJUSTES_URL, "ok", "read_only_access_revoked"),
  })(formData, ..._testArgs);
}
