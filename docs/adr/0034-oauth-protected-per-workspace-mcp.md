# The hosted agent-view MCP is an OAuth-protected resource, scoped to one workspace per token

ADR 0023 exposed the **agent-view** as a read-only API and over **MCP** so an AI agent
can explore a workspace's finances; ADR 0030 made the hosted app **multi-tenant** — one
libSQL/Turso database per **workspace**, behind Google sign-in, with a **control plane**
mapping users → workspaces → grants. But the two never met: the hosted `/api/mcp` endpoint
cannot be used by a real user from Claude. `middleware.ts` runs Auth.js over every request
and redirects an unauthenticated one to `/login` (an HTML 302); Claude's MCP client then
tries OAuth discovery, fetches a non-existent `/.well-known/oauth-protected-resource` (an
HTML 404), and fails with `SDK auth failed: Failed to parse JSON`. Today the only way the
MCP tools return real data is the logged-out **demo persona** chosen by a cookie; a
signed-in user has no way to let Claude read _their own_ workspace, and nothing would stop
one user's Claude from reaching another's data. We make the hosted agent-view MCP endpoint
an **OAuth 2.1 protected resource**: a user adds worthline as a connector, Claude runs the
standard MCP authorization handshake, the user logs in **with Google** (the existing
Auth.js identity, federated through a managed Authorization Server), and Claude receives a
read-only access token. Every MCP request carries that token; worthline validates it,
resolves the user's **workspace**, and runs the agent-view tools against **that workspace's
database** through the existing **store seam**. A token minted for one workspace can never
read another's. Demo and local no-auth modes keep working exactly as before.

## Considered options

- **`mcp-handler` resource server + a managed Authorization Server (WorkOS) for DCR +
  Google/Auth.js as the upstream IdP** (chosen) — the OAuth mechanics live in a library
  worthline already ships (`mcp-handler@1.1.0`: `protectedResourceHandler` for the RFC 9728
  metadata, `metadataCorsOptionsRequestHandler` for browser clients, `withMcpAuth` for the
  401 + `WWW-Authenticate` gate), so worthline owns only token _validation_ and the
  tenant mapping — not the security-critical surface of issuing tokens, registering
  clients, and handling PKCE. claude.ai connectors **require** Dynamic Client Registration
  (RFC 7591), which Google/Auth.js do not provide, so a DCR-capable AS is mandatory; WorkOS
  supplies it and **federates Google** upstream, preserving the single identity and the
  existing `await auth()` grain. The AS stays swap-able (Stytch/Auth0) behind the env that
  names it.
- **A user-pasted static bearer token** — rejected: claude.ai connectors do not support it
  (`static_bearer` "not yet supported"), and "Anthropic-held credentials" is one credential
  per connector, not per-user, so it gives **no tenant isolation**. Standardizing on OAuth
  covers both claude.ai and Claude Code, so no second auth path is built.
- **Hand-rolling the Authorization Server** — rejected: issuing tokens, DCR, and PKCE are
  exactly the security-critical surface a solo maintainer should not own.
- **`mcp-auth.dev` (Logto's library)** — rejected as redundant: it is a resource-server
  helper, the layer `mcp-handler` already covers, and provides no AS and no DCR — it would
  not fill the gap that matters.

## Consequences

- **`verifyMcpToken` is the tenant seam.** It validates the AS-issued JWT (signature
  against the AS JWKS, issuer, **audience = worthline's resource identifier** per RFC 8707
  so a token for another audience cannot be replayed, and expiry), extracts the subject,
  and maps it to a **workspace** via the **control plane** — the same users → workspaces →
  grants that govern web sign-in (ADR 0030). It returns the MCP `AuthInfo` carrying the
  workspace identity and a single read-only scope; an invalid / expired / ungranted token
  returns "no auth" → 401. Its JWKS verifier and control-plane lookup are **injectable**,
  so tests exercise it with a locally-signed token and never contact WorkOS.
- **The MCP catalog becomes per-request and target-bound.** Today `route.ts` builds the
  catalog **once at module load**, so its tools cannot see `req.auth` and resolve the store
  from the persona-cookie / demo context. For the authenticated path the catalog is rebuilt
  per request from the `StoreTarget` **resolved from the token's workspace** and runs every
  `withStore(run, target)` against that workspace's database. `resolveStoreTarget` gains a
  token-derived **authenticated** source (`{ workspaceId, dbUrl, token }`, where `token` is
  the env Turso **group** token — _not_ the OAuth token; the two are never conflated). The
  demo (persona cookie) and local (no-auth) paths through the catalog are preserved.
- **A token minted for workspace A can never yield workspace B's data**, and a regression
  test at the `/api/mcp` seam — two in-memory workspaces, a token for each, A's token proven
  unable to read B — guards that property against future refactors. This is the project's
  primary risk: a bug here leaks one user's net worth to another.
- **Discovery is reachable while logged out.** A new `/.well-known/oauth-protected-resource`
  route serves RFC 9728 metadata (`resource` = worthline's public HTTPS origin, derived
  respecting Vercel proxy headers — never the internal request URL; `authorization_servers`
  env-driven) plus a CORS preflight for browser clients; the page-access gate
  (`shouldRedirectToLogin`) is extended so both `/api/mcp` and the metadata route bypass the
  `/login` redirect — otherwise the Auth.js bounce swallows the handshake (the exact cause
  of the current symptom).
- **Gating engages only when auth is configured (hosted).** The wrapper short-circuits to
  the ungated handler when `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` are absent, mirroring
  `resolveStoreTarget`'s `authConfigured` check, so the local no-auth single-user mode and
  the logged-out demo MCP path stay open and unchanged — daily development and the offline
  test suites run exactly as before.
- **The grant is least-privilege and read-only.** A single `worthline:read` scope matches
  the agent-view's side-effect-free contract (ADR 0023); no write scope exists. Connected-
  source secrets stay encrypted at rest and out of every MCP response (ADR 0030 / ADR 0016
  hold), so opening MCP to a remote client does not widen their exposure.
- **Extends** ADR 0023 (agent-view read-only API) and ADR 0030 (multi-tenant hosted
  workspace). Provisioning is unchanged — it happens on first web sign-in (ADR 0030); MCP
  assumes a provisioned workspace. The AS, Dynamic Client Registration, and the deploy
  configuration are the one external dependency, introduced last (S4 / #442); the resource
  server, token validation, and tenant isolation are pure code landed first (S1–S3).
