# Deploy checklist — OAuth-protected MCP (WorkOS Authorization Server)

> S4 of PRD [#438](https://github.com/jenarvaezg/worthline/issues/442). The pure code
> (S1–S3) is merged; this is the **config + deploy** step. It is config-heavy and
> partly manual: WorkOS console + Vercel env + an end-to-end check against a real
> Claude connector. See **ADR 0034** for the decision and seams.

## What S1–S3 already shipped

- `/.well-known/oauth-protected-resource` serves RFC 9728 metadata; `/api/mcp` returns
  `401 + WWW-Authenticate` pointing at it (kills "Failed to parse JSON"). Gating engages
  only when auth is configured (`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`).
- `verifyMcpToken` validates the JWT (signature vs JWKS, issuer, audience, expiry, pinned
  algorithms) and maps the subject's **email → control-plane user → first granted
  workspace**. It **fails closed** when the Authorization-Server env is absent.
- The agent-view catalog is per-request and **token-bound**: a valid token reads only its
  own workspace (regression-guarded by `route.tenant-isolation.test.ts`).

So before this step, a hosted `/api/mcp` advertises discovery but **accepts no token** —
`verifyMcpToken`'s production path returns `undefined` until the env below is set.

## 1. WorkOS console

1. Create (or reuse) a WorkOS environment. It is the **Authorization Server**: it provides
   authorize/token endpoints, **Dynamic Client Registration (RFC 7591 — mandatory for
   claude.ai)**, PKCE, and a JWKS.
2. **Federate Google** as the upstream connection so users still "log in with Google" — the
   same identity Auth.js uses (ADR 0030/0034). Do **not** add a second identity provider at
   launch.
3. Confirm the AS issues access tokens that carry:
   - `sub` — the stable WorkOS user id (becomes `AuthInfo.clientId`).
   - `email` — the **verified** Google email (keys the control-plane user). Verify the
     environment only issues tokens for verified addresses (the code trusts this invariant).
   - `aud` — set to worthline's **resource identifier** (the public origin; see step 2).
4. Note three values for the env:
   - **Issuer** URL (matches the `iss` claim and RFC 8414 metadata).
   - **JWKS** URL.
   - The **signing algorithm** (WorkOS signs with **RS256**; the code pins
     `ACCEPTED_TOKEN_ALGORITHMS = ["RS256"]` in `verify-token.ts` — if WorkOS reports a
     different alg, update that constant).

## 2. Vercel env vars (names only — values are secrets)

Set on the `worthline-web` project. **Names**, what they wire, and where the code reads them:

| Env var                                 | Wires                                                                                            | Read in                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `WORTHLINE_MCP_AUTH_SERVER_URL`         | AS **issuer** — advertised in `.well-known` `authorization_servers` and checked as the JWT `iss` | `.well-known/.../route.ts`, `verify-token.ts` |
| `WORTHLINE_MCP_JWKS_URL`                | AS **JWKS** endpoint — the signature verifier                                                    | `verify-token.ts` (`createRemoteJWKSet`)      |
| `WORTHLINE_MCP_RESOURCE_URL`            | worthline's **resource id** — the JWT `aud` (RFC 8707 replay guard)                              | `verify-token.ts`                             |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Already set — their presence **engages MCP gating** (hosted)                                     | `route.ts`, `auth-gate.ts`                    |
| `WORTHLINE_CONTROL_PLANE_DB_URL`        | Already set — email→workspace lookup (control plane)                                             | `verify-token.ts` (`envResolveWorkspace`)     |
| `WORTHLINE_DB_AUTH_TOKEN`               | Already set — the **Turso group token** that opens a workspace DB (NOT the OAuth token)          | `store-resolver.ts`                           |

Notes (per ADR 0030 grain):

- The control-plane var is distinct from any workspace DB var; do not conflate them.
- These are read at request time, so a redeploy is not required to pick up a value change,
  but Vercel applies env changes on the next deploy/invocation — redeploy to be safe.
- All three `WORTHLINE_MCP_*` must be present together, or `verifyMcpToken` fails closed
  (accepts nobody) — that's the safe default, not a bug.
- `WORTHLINE_MCP_RESOURCE_URL` must equal the `resource` the `.well-known` route advertises
  (worthline's public HTTPS origin, e.g. the clean Vercel alias), or the audience check
  rejects every token.

## 3. End-to-end validation (manual)

Provisioning is unchanged (first **web** sign-in creates the workspace, ADR 0030) — sign in
on the web once first so a workspace + grant exist for your Google account.

- **claude.ai custom connector**: add worthline's `/api/mcp` as a connector. Expect: OAuth
  discovery → a browser **Google login** (federated via WorkOS) → consent → read-only token.
  Then ask Claude about your finances and confirm it reads **your** workspace.
- **Claude Code**: `claude mcp add` against the hosted `/api/mcp`, complete the same login,
  confirm the agent-view tools return your data.
- **Isolation spot-check**: with a second Google account (second workspace), confirm each
  connection sees only its own data.

## 4. Cleanup

- Delete the throwaway spike branch `spike/mcp-oauth` (its learnings are captured in S1–S3
  and ADR 0034). There is no spike test on `main` to remove — `route.test.ts` is the real one.

## Failure-mode quick reference

| Symptom                                        | Likely cause                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `SDK auth failed: Failed to parse JSON`        | `.well-known` unreachable or `/login` redirect still swallowing it — check `auth-gate.ts` allowlist and that the route is deployed |
| Every token → `401`                            | `WORTHLINE_MCP_*` env missing/partial (fail-closed), wrong `aud`/`iss`, or alg mismatch (RS256)                                    |
| Token accepted but tools return no/"stub" data | Workspace not provisioned for that email (sign in on web first), or `email` claim absent/unverified                                |
| `401` only after a while                       | Token expired and the client did not refresh — expected; reconnect                                                                 |
