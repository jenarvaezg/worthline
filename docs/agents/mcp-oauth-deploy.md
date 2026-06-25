# Deploy runbook — OAuth-protected MCP (WorkOS Authorization Server)

> PRD [#438](https://github.com/jenarvaezg/worthline/issues/438), ADR 0034. The code
> (S1–S3) is merged; this is the **config + deploy** step, per WorkOS environment. It
> went live end-to-end on 2026-06-21 (WorkOS Staging, then Production). This runbook is
> the real, tested recipe — follow it verbatim when wiring a new WorkOS environment.

## What the code does (so the config makes sense)

- `/.well-known/oauth-protected-resource` serves RFC 9728 metadata: `resource` = worthline's
  public HTTPS origin (from proxy headers), `authorization_servers` = `WORTHLINE_MCP_AUTH_SERVER_URL`.
- `/api/mcp` is gated by `withMcpAuth` **only when `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` are set**
  (hosted). No/invalid token → `401` + `WWW-Authenticate … resource_metadata="…"`. Local no-auth
  and the demo (persona cookie) paths stay open.
- `verifyMcpToken` validates the JWT (signature vs JWKS, issuer, **audience = the resource id**,
  expiry, pinned **RS256**), then resolves the caller's **email** and maps it to a workspace.
- **Email resolution — the non-obvious part.** WorkOS access tokens carry only the `sub`
  (the WorkOS user id), **not** an `email` claim, and OIDC `userinfo` 401s because the MCP
  client's token lacks the `openid` scope (the DCR/CIMD flow can't be forced to request it).
  So worthline fetches the email from the **WorkOS User Management directory** —
  `GET https://api.workos.com/user_management/users/{sub}` with the secret `WORKOS_API_KEY`
  (scope-independent). That email keys the control plane → the user's workspace.
- Tenant isolation: a token for workspace A can only ever read A (ADR 0034, regression-tested).

## WorkOS console — per environment (Staging AND Production are configured separately; nothing carries over)

1. **Connect → Configuration → MCP Auth → Manage**: enable **Dynamic Client Registration** and
   **Client ID Metadata Document** (claude.ai registers via CIMD; keep DCR on for compatibility).
2. **Connect → Configuration → MCP resource indicators → Edit MCP resources**: add the public
   origin, e.g. `https://worthline-web.vercel.app`. **This must equal the `resource` the
   `.well-known` route serves.** If it is missing, the `authorize` request is rejected with
   `error=invalid_target` (which surfaces in claude.ai as the misleading `state: Field required`).
3. **Authentication → Providers → Google → Enable**:
   - **Staging** may use WorkOS "Demo credentials" (real Google login, fine for testing).
   - **Production** requires your **own** Google OAuth client (demo creds are staging-only). Reuse
     worthline's existing client (`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` in `apps/web/.env.local`):
     paste the Client ID + Secret, keep scopes `userinfo.email` + `userinfo.profile`.
   - **Critical:** copy the **Redirect URI** the Google dialog shows
     (`https://auth.workos.com/sso/oauth/google/<connection-id>/callback`) and add it to that
     Google Cloud OAuth client's **Authorized redirect URIs**, or Google rejects with
     `redirect_uri_mismatch` and the flow dies before the login screen.
4. **API Keys**: note the environment's **secret key** (`sk_test_…` for Staging, `sk_live_…` for
   Production) → this is `WORKOS_API_KEY`.
5. **AuthKit domain** (Domains card, or `curl https://<authkit-domain>/.well-known/oauth-authorization-server`)
   → gives the `issuer` and `jwks_uri`. Differs per environment (Staging had a `…-staging.authkit.app`).

## Vercel env vars (`worthline-web`, Production scope) — all four from the SAME WorkOS environment

| Var                             | Value                                                                                 | Source                |
| ------------------------------- | ------------------------------------------------------------------------------------- | --------------------- |
| `WORTHLINE_MCP_AUTH_SERVER_URL` | the AuthKit `issuer` (e.g. `https://<id>.authkit.app`)                                | AS metadata           |
| `WORTHLINE_MCP_JWKS_URL`        | `<issuer>/oauth2/jwks`                                                                | AS metadata           |
| `WORTHLINE_MCP_RESOURCE_URL`    | the public origin, e.g. `https://worthline-web.vercel.app` (= the resource indicator) | unchanged across envs |
| `WORKOS_API_KEY`                | the environment's secret key (`sk_test_`/`sk_live_`)                                  | API Keys              |

`AUTH_GOOGLE_ID/SECRET`, `WORTHLINE_CONTROL_PLANE_DB_URL`, `WORTHLINE_DB_AUTH_TOKEN` are already set.
The three `WORTHLINE_MCP_*` engage the verifier together — if any is missing it **fails closed**
(accepts nobody). After changing any var, **redeploy** (env is baked per deployment): push to main
(auto-deploy via `.github/workflows/deploy.yml`) or `gh workflow run deploy.yml`.

⚠️ Mixing environments is the easiest mistake: the `issuer`/`jwks`/`WORKOS_API_KEY` must all be from
the same WorkOS environment, or the directory lookup hits the wrong env and every token is rejected.

## Validate

1. `curl https://worthline-web.vercel.app/.well-known/oauth-protected-resource` → `authorization_servers`
   points at the right AuthKit domain (not the `.invalid` placeholder, not the wrong env).
2. Sign into worthline **on the web** once with Google → provisions your workspace (MCP never provisions).
3. claude.ai → add custom connector `https://worthline-web.vercel.app/api/mcp` (OAuth fields empty) →
   Google login → ask about your finances → reads **your** workspace only.

## Failure-mode quick reference

| Symptom                                                                                         | Cause                                                                                               |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `SDK auth failed: Failed to parse JSON`                                                         | `.well-known` unreachable / `/login` redirect swallowing it                                         |
| claude.ai shows `state: Field required`; callback URL is `…/auth_callback?error=invalid_target` | the `resource` is **not** registered as an MCP resource indicator **in that WorkOS environment**    |
| Login screen never appears, flow dies at `authorize`                                            | Google provider not configured in that env, or `redirect_uri_mismatch` in Google Cloud              |
| `[mcp-auth] reject: JWT validation failed` (`claim: aud`/`iss`)                                 | env vars from the wrong WorkOS environment, or `WORTHLINE_MCP_RESOURCE_URL` ≠ advertised `resource` |
| `[mcp-auth] WorkOS user lookup failed status=401`                                               | `WORKOS_API_KEY` missing or from the wrong environment                                              |
| `[mcp-auth] reject: no granted workspace`                                                       | the caller never signed into worthline web (no control-plane user/workspace for that email)         |

## Custom domains (future polish)

- **App domain** (e.g. `worthline.app`) — it **is** the `resource`/audience, so changing it means:
  update `WORTHLINE_MCP_RESOURCE_URL` + the WorkOS resource indicator + re-add the connector.
- **AuthKit custom domain** (e.g. `auth.worthline.app`, WorkOS Production → Domains) — nicer login
  branding; changes `issuer`/`jwks` → update those two env vars + re-add the connector.

## Daily snapshot cron (ADR 0037, PRD #528)

`vercel.json` schedules `GET /api/cron/snapshot` at `0 21 * * *` (21:00 UTC, close-of-day).
The route captures today's snapshot for **every** workspace (it lists them from the control plane
and opens each per-workspace DB with the existing `WORTHLINE_DB_AUTH_TOKEN`, no session).

| Var           | Value                             | Notes                                                                                                                   |
| ------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CRON_SECRET` | a long random string (Production) | Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>`; the route **fails closed** if it is unset or mismatched. |

- Set `CRON_SECRET` in the `worthline-web` Production scope, then **redeploy** (env is baked per deployment).
- Manual trigger by a token holder: `curl -H "Authorization: Bearer $CRON_SECRET" https://worthline-web.vercel.app/api/cron/snapshot`.
- The job uses the **real clock** and ignores `WORTHLINE_DEMO_NOW` — never set that var in Production.
