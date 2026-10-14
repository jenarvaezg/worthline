/**
 * The pure half of «Acceso de solo lectura» (#1844, S4 of #1718, ADR 0112):
 * the owner's viewer list folded with the mutations still in flight, the plan of
 * a share before any round trip, and the Spanish words for every refusal of the
 * sharing door (`shareWorkspaceReadOnly`, #1841).
 *
 * Giving and taking access are optimistic (interaction-patterns §4): the row IS
 * the address the owner typed, so the optimistic row is the stored one. A refusal
 * the client can already see — not an email, oneself, someone on the list, the
 * list full — is decided here before anything is sent, so a row never appears
 * only to vanish. The server stays the authority and decides all of them again.
 *
 * Pure (no React, no `@worthline/db` runtime), so it unit-tests in node and ships
 * to the client island without the persistence package.
 */

import { comparableEmail } from "@web/comparable-email";
import type { ShareWorkspaceRefusal } from "@worthline/db";
import { formatDateKeyEs } from "@worthline/domain";

/*
 * The door's rules, copied: `MAX_VIEWERS`, `EMAIL_SHAPE` and `MAX_EMAIL_LENGTH`
 * mirror `MAX_VIEWERS_PER_WORKSPACE`, `VIEWER_EMAIL_SHAPE` and
 * `MAX_VIEWER_EMAIL_LENGTH` (`packages/db/src/viewer-sharing.ts`). Copied, not
 * imported, because this module ships to the client island and `@worthline/db`
 * has no subpath the browser can load without pulling libsql in; a test
 * (`read-only-sharing.test.ts`) pins the copies to the originals. The door
 * enforces them atomically either way — the copies only spare a round trip.
 */

/** At most this many viewers per workspace — the #1718 triage's cap. */
export const MAX_VIEWERS = 5;

/** One person who may view the owner's workspace, as the list shows them. */
export interface ViewerRow {
  /** Null while the share is in flight: there is nothing to take back yet. */
  userId: string | null;
  email: string;
  /** The calendar day access was given (`YYYY-MM-DD`). */
  since: string;
}

/** What the owner can do to the list before the server answers. */
export type ViewerMutation =
  | { kind: "add"; email: string; since: string }
  | { kind: "remove"; userId: string };

/** The control plane's viewers (`listViewersOfWorkspace`) as list rows. */
export function viewerRowsFrom(
  viewers: readonly { userId: string; email: string; createdAt: string }[],
): ViewerRow[] {
  return viewers.map((viewer) => ({
    email: viewer.email,
    // `CURRENT_TIMESTAMP` («2026-10-01 09:30:00») or an ISO instant: the day is
    // the first ten characters either way, and the list names no time of day.
    since: viewer.createdAt.slice(0, 10),
    userId: viewer.userId,
  }));
}

/** The list with one pending mutation applied, as a fresh array. */
export function applyViewerMutation(
  rows: readonly ViewerRow[],
  mutation: ViewerMutation,
): ViewerRow[] {
  switch (mutation.kind) {
    case "add":
      return [...rows, { email: mutation.email, since: mutation.since, userId: null }];
    case "remove":
      return rows.filter((row) => row.userId !== mutation.userId);
    default: {
      const unhandled: never = mutation;
      return unhandled;
    }
  }
}

/** «desde el 01/10/2026» — the list's date column. */
export function viewerSinceLabel(since: string): string {
  return `desde el ${formatDateKeyEs(since)}`;
}

/** The form id a no-JS refusal names, so /ajustes puts the error in the section. */
export const READ_ONLY_ACCESS_FORM_ID = "readOnlyAccess";

/** Said when the share failed for a reason that is not the person's to fix. */
export const SHARE_FAILURE_MESSAGE =
  "No se pudo dar el acceso. Inténtalo de nuevo en un momento.";

/** Said when taking access back failed. */
export const REVOKE_FAILURE_MESSAGE =
  "No se pudo quitar el acceso. Inténtalo de nuevo en un momento.";

/**
 * Why a share is turned away, as the section words it: every typed refusal of
 * the door, plus `already-viewer` — the door's idempotent success
 * (`created: false`), which to the owner who typed the address is a mistake
 * worth saying. Distinct from `conflicting-grant`: that person holds a grant of
 * another kind, and «ya tiene acceso» would be false.
 */
export type ShareRefusalReason = ShareWorkspaceRefusal | "already-viewer";

const REFUSAL_MESSAGES: Readonly<Record<ShareRefusalReason, string>> = {
  "already-viewer": "Esa persona ya tiene acceso.",
  "conflicting-grant":
    "Esa persona tiene otro tipo de acceso a tu espacio, y desde aquí no se puede convertir en solo lectura.",
  "invalid-email": "Escribe un email válido, como nombre@ejemplo.com.",
  // The owner has nothing to fix: a session that reached this door owns a
  // workspace (ADR 0030), so this is the system's failure, not theirs.
  "no-owned-workspace": SHARE_FAILURE_MESSAGE,
  "self-share": "Ese es tu propio email: tu espacio ya lo ves tú.",
  "viewer-limit": `Ya hay ${MAX_VIEWERS} personas con acceso, el máximo. Quita a alguien antes de dar acceso a otra.`,
};

/** The message for a refusal of the sharing door, or for an address already on the list. */
export function shareRefusalMessage(reason: ShareRefusalReason): string {
  return REFUSAL_MESSAGES[reason];
}

/**
 * The same pragmatic shape the door checks: one `@`, a non-empty local part, a
 * dotted domain, no whitespace, at most 254 characters.
 */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_LENGTH = 254;

/** What a share does: show the new row at once, or say why not without a round trip. */
export type SharePlan =
  | { kind: "optimistic"; email: string }
  | { kind: "reject"; error: string };

/** Plan a share of the owner's workspace with `email`. */
export function planShare({
  email,
  ownerEmail,
  viewers,
}: {
  email: string;
  ownerEmail: string;
  viewers: readonly ViewerRow[];
}): SharePlan {
  const viewerEmail = comparableEmail(email);
  if (viewerEmail.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(viewerEmail)) {
    return { error: shareRefusalMessage("invalid-email"), kind: "reject" };
  }
  if (viewerEmail === comparableEmail(ownerEmail)) {
    return { error: shareRefusalMessage("self-share"), kind: "reject" };
  }
  if (viewers.some((viewer) => comparableEmail(viewer.email) === viewerEmail)) {
    return { error: shareRefusalMessage("already-viewer"), kind: "reject" };
  }
  if (viewers.length >= MAX_VIEWERS) {
    return { error: shareRefusalMessage("viewer-limit"), kind: "reject" };
  }
  return { email: viewerEmail, kind: "optimistic" };
}

/**
 * What a sharing action resolves to on the inline path: nothing worth reading on
 * success (it redirects), a refusal otherwise — `FormActionState`'s shape.
 */
export type SharingActionResult =
  | { ok: true }
  | { ok: false; error: string; values?: Record<string, string> };

/** The island's side of a submit, injected so the choreography tests in node. */
interface SubmitDeps {
  action: (formData: FormData) => Promise<SharingActionResult>;
  formData: FormData;
  /** The refusal to show, or null to clear the previous one as a submit leaves. */
  onRefusal: (message: string | null) => void;
  showOptimistic: (mutation: ViewerMutation) => void;
  startTransition: (scope: () => Promise<void>) => void;
}

/**
 * Run one share (#1844): refuse on the spot what the client can see, otherwise
 * show the row, clear the field and send with `inlineError` stamped on the body
 * (never in the HTML, #1311), bringing a server refusal and what was typed back.
 *
 * There is no in-flight gate: a second share while the first is still travelling
 * is sent too, never dropped in silence. The plan reads the rows WITH the pending
 * ones (a thunk, read at submit time), so the cap and «ya tiene acceso» still
 * count what is in flight; the server is the atomic arbiter either way.
 */
export function submitShare({
  action,
  formData,
  onRefusal,
  ownerEmail,
  rows,
  setDraft,
  showOptimistic,
  startTransition,
  today,
}: SubmitDeps & {
  ownerEmail: string;
  rows: () => readonly ViewerRow[];
  setDraft: (email: string) => void;
  today: string;
}): void {
  const typed = String(formData.get("viewerEmail") ?? "");
  const plan = planShare({ email: typed, ownerEmail, viewers: rows() });
  if (plan.kind === "reject") {
    onRefusal(plan.error);
    return;
  }
  formData.set("inlineError", "1");
  onRefusal(null);
  setDraft("");
  startTransition(async () => {
    showOptimistic({ email: plan.email, kind: "add", since: today });
    const result = await action(formData);
    if (!result.ok) {
      onRefusal(result.error);
      setDraft(result.values?.["viewerEmail"] ?? typed);
    }
  });
}

/**
 * Run one revoke (#1844): the row leaves at once and the body goes with
 * `inlineError` stamped; a server refusal brings the row back (the optimistic
 * state ends with the transition) and says why. Concurrent revokes are each sent.
 */
export function submitRevoke({
  action,
  formData,
  onRefusal,
  showOptimistic,
  startTransition,
  userId,
}: SubmitDeps & { userId: string }): void {
  formData.set("inlineError", "1");
  onRefusal(null);
  startTransition(async () => {
    showOptimistic({ kind: "remove", userId });
    const result = await action(formData);
    if (!result.ok) onRefusal(result.error);
  });
}
