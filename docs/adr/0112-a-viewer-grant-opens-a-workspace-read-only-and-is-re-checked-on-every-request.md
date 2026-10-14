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
   Resolution, as built:
   - The cookie is unsigned, `httpOnly`, 12 hours, with the app's cookie posture
     (`appCookieOptions`); its name lives in a dependency-free module
     (`viewing/viewing-cookie.ts`).
   - With a session and the cookie, `readStoreTarget` (under `cache`, so once per
     request) calls `readViewerAccess({ viewerEmail: <session email, trimmed and
     lower-cased>, workspaceId: <cookie> })` once. No cookie, or no session
     email, means no control-plane call at all.
   - `resolveStoreTarget` receives the result as `viewedWorkspace` and honors it
     only when its `viewerEmail` equals *this* session's email (recompared there,
     never trusted from the caller) and its read-only token is non-empty — a
     viewer never falls back to the group token. It resolves
     `{ kind: "authenticated", workspaceId, dbUrl, token: readOnlyToken,
     sharedByEmail: ownerEmail }`.
   - Precedence: admin impersonation > viewer > the session's own workspace. A
     forged cookie, a revoked grant or a lookup that names another email resolves
     exactly as if the cookie were absent; without a session the request stays
     unauthenticated (or the demo, with a persona cookie).
   - Entering and leaving are route handlers that only touch cookies, like
     `/scope`: `POST /viewing` (`workspaceId`) sends a request without a session
     to `/login`, checks `readViewerAccess` *before* setting the cookie (no grant
     → `/ajustes`, no cookie), drops the member scope and goes to `/app`;
     `POST /viewing/exit` clears both cookies and goes to `/app`.
6. **One classifier, one gate.** `blockedWriteMessage` is the only place that
   decides whether a session may write; a guardian forbids copies. Every door —
   Server Actions, chat, export, checkout — refuses the viewer, each with its
   test (#1843). As built: the classifier answers «Acceso de solo lectura: desde
   aquí no se puede cambiar nada de este espacio.» for a viewer; its two narrow
   readings live beside it in `demo/write-guard.ts` — `actsOnOwnAccount` (signed
   in, in one's own workspace, no read-only reason: onboarding, feedback, quota)
   and `viewsSharedWorkspace` (the doors closed to a viewer only). The
   `read-only-classifier-guardian` lets only the classifier, the resolver, the
   port and the bands name `impersonatedEmail` or `sharedByEmail`. Underneath it, a viewer principal's store rejects any statement
   that is not a `SELECT` (#1842), and underneath that, the credential itself is
   read-only. Write controls stay visible (the demo and impersonation precedent);
   the gate refuses them.
7. **Scope of v1.** The viewer sees every figure and record. Not in v1: the
   assistant (a turn writes drafts into the owner's workspace and spends the
   owner's quota — the route answers 403 `read_only` right after the
   authentication check, before providers, rate limit, quotas or store, and the
   launcher is not mounted), `/ajustes` and `/ajustes/conexiones` (redirect to
   `/app`), the export (403: it is the owner's copy and would survive
   revocation), billing (`/premium` — the owner's plan, subscription and billing
   portal — redirects to `/app`; `/premium/pagar` redirects to `/premium`
   without creating a checkout), statement import (`/patrimonio/importar-extracto`
   redirects to `/app`), onboarding (`/bienvenida` redirects to `/app`), the MCP
   (owner only), self-removal, invitation email. `/empezar`, where `/app` sends an
   empty workspace, shows a viewer a static «Este espacio todavía está vacío» with
   the exit instead of the creation form, so `/app` ↔ `/empezar` cannot loop.
   Underneath the doors, the control-plane writes a request can trigger — the
   activation marks and the source-sync queue — do nothing unless the session
   acts on its own account, whatever order a caller ran its guards in. Signing
   out clears `wl_viewing` and the member scope with the session.
   Impersonation is unchanged.

8. **The surfaces (#1844).** «Acceso de solo lectura» on `/ajustes` is the
   owner's door: an email and «Dar acceso», the list of viewers with the day
   each got access and «Quitar acceso» behind a confirmation. Both actions go
   through `formActionInlineError` — its guard turns away every read-only
   session — and call the S1 commands with the session's email; giving and
   taking access are optimistic, and a refusal the client can already see is
   decided before the round trip. «Compartidos contigo» (on `/ajustes`, and on
   `/bienvenida`, where an identity that was only invited lands) posts to
   `POST /viewing`. Both sections exist only for a session acting on its own
   account. While viewing, the root layout carries a neutral session band
   naming the owner with «Volver a mi espacio» (`POST /viewing/exit`), and the
   topnav drops «Ajustes».

## Consequences

- A grant that is not the owner's can never become ownership through the
  provisioner, the MCP, or any owner-email lookup; tests pin each path.
- The MCP no longer rejects an owner who also views someone else's workspace as
  «multiple granted workspaces».
- **Revoking does not rotate the read-only token.** Turso read-only tokens are
  per database and do not expire; revoking a viewer removes the grant, which is
  what the per-request check reads, and the token stays on the workspace row for
  every other viewer. The guarantee therefore rests on the token never leaving
  the server: it must **never be serialized to the browser** — not in a session
  or JWT, not in an RSC payload or client prop, not in a log. A revoked viewer
  who had kept a copy could still read until an operator rotates it.
- The token is sealed once (`UPDATE … WHERE db_read_only_token IS NULL`):
  concurrent first shares converge on whichever landed first. The five-viewer
  cap is a single `INSERT … SELECT … WHERE count < 5`, so concurrent shares
  cannot exceed it.
- Users are looked up by email case-insensitively, so a share to `foo@x.com`
  reaches the identity that signed in as `Foo@x.com`. There is no unique index
  on `lower(email)`; existing rows were not migrated.
- v2 is the natural next step: the viewer *proposes* through the assistant's
  proposal machinery and the owner confirms — the advisor → owner flow that
  motivated this.
