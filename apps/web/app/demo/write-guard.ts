/**
 * Read-only write guard (PRD #297, S2 #300, ADR 0030; extended for admin
 * impersonation, #697, and for the viewer of a shared workspace, #1843). The
 * read-only enforcement seam: every mutating server action calls it FIRST,
 * before any store access. For a demo request, an admin impersonating a
 * workspace or a viewer, it short-circuits the mutation —
 * redirecting with a friendly message via the existing error-redirect intake —
 * so a direct URL or POST cannot change anything. For a live request
 * (one's own authenticated workspace, or local) it is a no-op and the action
 * proceeds as before.
 *
 * Demo-ness, impersonation and viewing are per-request facts resolved by the store
 * seam, so the guard is async — `await guardDemoWrite(...)` on an action's
 * first line. Every existing mutating action already calls it that way, so
 * extending this ONE seam covers impersonation across the whole app with no
 * per-action change — and the viewer (#1843) the same way.
 */

import { errorRedirectUrl } from "@web/intake";

import { readStoreTarget } from "@web/read-store-target";
import type { StoreTarget } from "@web/store-resolver";
import { redirect } from "next/navigation";
import {
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
  VIEWER_READONLY_MESSAGE,
} from "./write-guard-messages";

export { DEMO_DISABLED_MESSAGE, IMPERSONATION_READONLY_MESSAGE, VIEWER_READONLY_MESSAGE };

/** Whether this request is the read-only demo (a logged-out persona). */
export async function isDemoMode(): Promise<boolean> {
  return (await readStoreTarget()).kind === "demo";
}

/** Whether this request is an admin impersonating another workspace (#697) — read-only. */
export async function isImpersonating(): Promise<boolean> {
  const target = await readStoreTarget();
  return target.kind === "authenticated" && target.impersonatedEmail !== undefined;
}

/**
 * Why a resolved target is read-only — the three reasons a session may not write.
 * Impersonation is read before the viewer: the resolver never builds a target
 * with both, and if one ever carried both, the admin's reason is the one to tell.
 */
type ReadOnlyReason = "demo" | "impersonation" | "viewer";

const READ_ONLY_MESSAGES: Readonly<Record<ReadOnlyReason, string>> = {
  demo: DEMO_DISABLED_MESSAGE,
  impersonation: IMPERSONATION_READONLY_MESSAGE,
  viewer: VIEWER_READONLY_MESSAGE,
};

function readOnlyReason(target: StoreTarget): ReadOnlyReason | null {
  if (target.kind === "demo") return "demo";
  if (target.kind !== "authenticated") return null;
  if (target.impersonatedEmail !== undefined) return "impersonation";
  if (target.sharedByEmail !== undefined) return "viewer";
  return null;
}

/**
 * The ONE classifier every write door shares (#1180, #1843): why this request
 * may not write, as the Spanish message the blocked user should see — or null
 * when it may. The read-only demo, an admin impersonating a workspace (#697) and
 * a session viewing a workspace shared with it (ADR 0112) are its three answers.
 *
 * Pure over an already-resolved target, so the guards below — and every surface
 * that asks (the proposal combinators, the assistant mount, onboarding, feedback,
 * the chat) — cannot drift apart. A guardian (`read-only-classifier-guardian`)
 * forbids reading the target's read-only markers anywhere else.
 */
export function blockedWriteMessage(target: StoreTarget): string | null {
  const reason = readOnlyReason(target);
  return reason === null ? null : READ_ONLY_MESSAGES[reason];
}

/**
 * Whether this request views a workspace someone else owns and shared with it
 * (#1843): the classifier's viewer answer, for the doors closed to a viewer and
 * only to a viewer — the chat, the export, `/ajustes`, the checkout,
 * `/bienvenida`, `/empezar`. Demo and impersonation keep their own rules there.
 */
export function viewsSharedWorkspace(
  target: StoreTarget,
): target is SharedWorkspaceTarget {
  return readOnlyReason(target) === "viewer";
}

/** A target that views a workspace shared with the session: whose it is, always. */
type SharedWorkspaceTarget = Extract<StoreTarget, { kind: "authenticated" }> & {
  sharedByEmail: string;
};

/**
 * For a page closed to a viewer (#1843, ADR 0112) — the owner's settings,
 * connections, billing, ingestion, onboarding — send a viewer to `to` before the
 * page reads anything. No-op for everyone else: the demo and impersonation keep
 * their own rules on those pages. Throws Next's redirect signal.
 */
export async function guardViewerPage(to: string): Promise<void> {
  if (viewsSharedWorkspace(await readStoreTarget())) {
    redirect(to);
  }
}

/**
 * Whether this request acts on its OWN account (#1843): a signed-in user in the
 * workspace they own, with no read-only reason at all. Not the demo, not local,
 * not an admin impersonating, not a viewer — only someone who can be onboarded,
 * send feedback in their own name, or spend their own quota.
 */
export function actsOnOwnAccount(
  target: StoreTarget,
): target is Extract<StoreTarget, { kind: "authenticated" }> {
  return target.kind === "authenticated" && blockedWriteMessage(target) === null;
}

/**
 * Why this request may not write to the REAL workspace it resolved to, or null
 * (#1845). The classifier above, narrowed to authenticated targets: the demo
 * answers null here because a chat draft of its lands in its own ephemeral store,
 * never in anyone's workspace. So this is the impersonation or viewer message, or
 * nothing — the seams that write as the workspace's owner without passing through
 * a Server Action (the chat's proposal store) close on it.
 */
export function workspaceWriteBlockedMessage(target: StoreTarget): string | null {
  return target.kind === "authenticated" ? blockedWriteMessage(target) : null;
}

/**
 * The workspace this request acts for AS ITS OWNER — the one whose AI quota it may
 * spend and in whose name it may alert the maintainer — or null (#1845). Null for
 * the demo and local, as before, for an admin impersonating a workspace (the admin
 * reads that user's data, but their turns are not the user's turns) and for a
 * viewer (#1843).
 */
export function ownWorkspaceId(target: StoreTarget): string | null {
  return actsOnOwnAccount(target) ? target.workspaceId : null;
}

/**
 * Whether this request must not write: the read-only demo, an admin
 * impersonating a workspace (#1180) or a viewer (#1843). The non-redirecting form of
 * {@link guardDemoWrite}, for a mutating action that must refuse SILENTLY rather
 * than navigate — a `void` action fired mid-conversation from the client, where
 * throwing Next's redirect signal would be wrong.
 *
 * An action that redirects should still use `guardDemoWrite`: the user gets the
 * honest Spanish message instead of a write that quietly did nothing.
 */
export async function isWriteBlocked(): Promise<boolean> {
  return blockedWriteMessage(await readStoreTarget()) !== null;
}

/**
 * For a demo, impersonated-admin or viewer request, abort a mutating action
 * by redirecting back to `currentUrl` with the matching message (the store is
 * never touched). No-op when live. Throws Next's redirect signal — await it
 * before opening a store.
 */
export async function guardDemoWrite(currentUrl: string): Promise<void> {
  const message = blockedWriteMessage(await readStoreTarget());
  if (message !== null) {
    redirect(errorRedirectUrl(currentUrl, { message }));
  }
}
