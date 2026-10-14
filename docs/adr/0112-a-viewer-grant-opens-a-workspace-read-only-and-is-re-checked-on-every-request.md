# A viewer grant opens a workspace read-only and is re-checked on every request

- Status: accepted
- Date: 2026-10-14
- Issue: #1718 (slices #1841, #1842, #1843, #1844)

## Context

ADR 0030 gave every grant a role, but only `owner` ever existed and nothing read
the column. Resolution listed every grant a user had, so the provisioner, the MCP
and the session token would all have treated any other grant as ownership, full
Turso token included. The «oldest grant» rule that named a workspace's owner for
impersonation, billing, the trial emails and the sync queue read any role too.

Meanwhile the one real external user's workspace was advised for two months from
outside the product: admin impersonation plus direct database reads. The owner
neither granted that access nor saw it, and could not take it back; nobody but an
admin could use it. The grill of 2026-07-02 had vetoed viewer grants when there
was no external user; the triage of #1718 reopened it on that evidence, and on the
pieces that now make it cheap: the authorization port (#998), the write guard
(#1180), read-only impersonation in production (#697), and Turso's read-only
tokens.

## Decision

1. **Two roles, read fail-closed.** `GrantRole = "owner" | "viewer"`. Any other
   stored value — the legacy `orphaned-owner` the #733 healing writes among them —
   grants nothing: it is not listed, it reads as no grant, and it never names an
   owner.
2. **Resolution returns owned workspaces only, by construction.**
   `listOwnedWorkspacesForUser` (`role = 'owner'`) is what the provisioner and the
   MCP resolve through. No method returns owned and shared workspaces together;
   viewers and shared workspaces have their own reads. The owner email of a
   workspace is its oldest `owner` grant. Every identity owns a workspace (ADR
   0030): one that only views another is provisioned its own on first sign-in,
   through the daily cap like anyone.
3. **The sharing door is the owner's own.** `shareWorkspaceReadOnly` resolves the
   workspace from the owner's grant; it is never a parameter, so only one's own
   workspace can be shared. It refuses an invalid email, sharing with oneself and
   a sixth viewer, with typed reasons, and is idempotent. The viewer gets a bare
   user row — no database, no trial, no cap. Invitation is by email, which Google
   verifies at sign-in; there is no invitation email and no link (with open
   registration, #733, the first is a spam relay and the second a bearer
   credential). `revokeWorkspaceReadOnly` deletes only `viewer` rows. There is
   one shareable role, so no role selector; co-ownership stays impossible
   (`grants_one_owner_per_user`).
4. **A read-only credential.** A viewer opens the workspace with a Turso
   `read-only` token, minted the first time the owner shares and sealed on the
   workspace row (`db_read_only_token`, control plane v11) like the full token,
   **before** any viewer grant is written: a failed mint leaves no grant.
   `readViewerAccess` returns it, in one query, only for an existing viewer grant
   on a workspace that has one; it never returns the full token. Schema
   maintenance is the system's, with the full token, which never enters a
   viewer's session or store target.
5. **The session is a cookie re-checked on every request** (`wl_viewing`, #1843),
   like impersonation: it carries a workspace id and grants nothing by itself;
   each request re-reads the grant of *this* session's email. Revocation is
   therefore immediate, and an owner without the cookie pays nothing.
6. **One classifier, one gate.** `blockedWriteMessage` is the only place that
   decides whether a session may write; a guardian forbids copies. Every door —
   Server Actions, chat, export, checkout — refuses the viewer, each with its
   test (#1843). Underneath it, a viewer principal's store rejects any statement
   that is not a `SELECT` (#1842), and underneath that, the credential itself is
   read-only. Write controls stay visible (the demo and impersonation precedent);
   the gate refuses them.
7. **Scope of v1.** The viewer sees every figure and record. Not in v1: the
   assistant (a turn writes drafts into the owner's workspace and spends the
   owner's quota — the route answers 403 and the launcher is not mounted),
   `/ajustes` (redirects to `/app`), the export (403: it is the owner's copy and
   would survive revocation), the MCP (owner only), self-removal, invitation
   email. Impersonation is unchanged.

## Consequences

- A grant that is not the owner's can never become ownership through the
  provisioner, the MCP, or any owner-email lookup; tests pin each path.
- The MCP no longer rejects an owner who also views someone else's workspace as
  «multiple granted workspaces».
- Turso read-only tokens are per database and do not expire; revoking a viewer
  removes the grant, which is what the per-request check reads. The token stays
  on the workspace row for the next viewer; rotating it is an operator action.
- v2 is the natural next step: the viewer *proposes* through the assistant's
  proposal machinery and the owner confirms — the advisor → owner flow that
  motivated this.
