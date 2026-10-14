import { actsOnOwnAccount } from "@web/demo/write-guard";
import type { FormErrorContext } from "@web/intake";
import { readSessionEmail, readStoreTarget } from "@web/read-store-target";
import { READ_ONLY_ACCESS_FORM_ID, viewerRowsFrom } from "@web/sharing/read-only-sharing";
import { loadWorkspaceSharing } from "@web/sharing/sharing-control-plane";
import SharedWithYou from "@web/viewing/shared-with-you";

import { ReadOnlyAccessSection } from "./read-only-access-section";
import { revokeReadOnlyAccessAction, shareReadOnlyAccessAction } from "./sharing-actions";

/**
 * The sharing sections of /ajustes (#1844, S4 of #1718, ADR 0112): «Acceso de
 * solo lectura» (who may view the owner's workspace) and «Compartidos contigo»
 * (whose workspaces the identity may view).
 *
 * Only for a session acting on its OWN account (`actsOnOwnAccount`): the demo, an
 * admin impersonating and a viewer never see a sharing control, and the control
 * plane is not read for them; local no-auth mode has no account to share from.
 * The actions refuse all of them again on a direct POST.
 *
 * Both lists are read with the session's email, never a workspace id, in one
 * control-plane connection.
 */
export async function readOnlySharingSections({
  formError,
  today,
}: {
  formError: FormErrorContext | null;
  today: string;
}) {
  if (!actsOnOwnAccount(await readStoreTarget())) return null;
  const email = await readSessionEmail();
  if (!email) return null;

  const { sharedWithMe, viewers } = await loadWorkspaceSharing(email);
  const ownError = formError?.formId === READ_ONLY_ACCESS_FORM_ID ? formError : null;

  return (
    <>
      <ReadOnlyAccessSection
        initialEmail={ownError?.values["viewerEmail"] ?? ""}
        initialError={ownError?.message ?? null}
        ownerEmail={email}
        revokeAction={revokeReadOnlyAccessAction}
        shareAction={shareReadOnlyAccessAction}
        today={today}
        viewers={viewerRowsFrom(viewers)}
      />
      <SharedWithYou className="ajustesPanel section" workspaces={sharedWithMe} />
    </>
  );
}
