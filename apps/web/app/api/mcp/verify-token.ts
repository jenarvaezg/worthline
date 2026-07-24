import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createControlPlaneStore, type TenancyDirectory } from "@worthline/db";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

/**
 * Resolve a bearer token presented to the agent-view MCP endpoint into the MCP
 * {@link AuthInfo} that identifies the caller's workspace (PRD #438, ADR 0034).
 *
 * The token is an OAuth access token the Authorization Server (WorkOS) issues
 * after a Google login. Three injectable seams keep the unit tests exercising
 * the real logic with a locally-signed token and never contacting WorkOS:
 *   - `verifyJwt` — signature against the AS JWKS, issuer, audience, expiry;
 *   - `resolveEmail` — the OIDC userinfo lookup (WorkOS access tokens carry the
 *     subject but NOT the email; email is fetched from `/oauth2/userinfo`);
 *   - `resolveWorkspace` — claims → workspace via the control plane.
 *
 * The Turso group token that actually opens a workspace database is unrelated to
 * this OAuth token; it stays in env and is wired by the store seam (S3).
 */

export const MCP_READ_SCOPE = "worthline:read";

/** What a successfully-validated JWT yields: a subject, and maybe an email claim. */
export interface VerifiedToken {
  /** Stable subject from the Authorization Server (the WorkOS user id). */
  subject: string;
  /** The `email` claim if the access token carries one; WorkOS does not, so this
   * is usually null and the email is fetched from userinfo instead. */
  email: string | null;
  /** The `email_verified` claim, strictly boolean-true. False when the claim is
   * absent, false, or any non-boolean value — see {@link VerifiedEmail}. */
  emailVerified: boolean;
}

/**
 * An email address plus whether its owner actually proved control of it (#1180).
 *
 * Both email sources — the token's own `email` claim and the WorkOS directory
 * lookup — carry this pair, because tenancy is resolved BY EMAIL: the control
 * plane maps `email → user → workspace`. An unverified address is therefore an
 * account-takeover vector, not a cosmetic detail: whoever registers someone
 * else's unconfirmed address at the Authorization Server would resolve to THEIR
 * workspace. Verification is opt-IN and strictly boolean — an absent claim, a
 * `false`, or a truthy-but-not-boolean value (`"true"`, `1`) all read as
 * unverified, so an AS that simply does not emit the claim fails closed.
 */
export interface VerifiedEmail {
  email: string;
  emailVerified: boolean;
}

export interface McpTokenClaims {
  subject: string;
  /**
   * Verified email (Google federated), used to resolve the control-plane user.
   * INVARIANT: the Authorization Server MUST only expose verified email
   * addresses (Google is the verified upstream IdP via WorkOS — ADR 0034). The
   * web sign-in keys the control plane by the same Google email (ADR 0030), so
   * MCP and web resolve the same user.
   *
   * Since #1180 that invariant is ASSERTED rather than assumed: nothing reaches
   * this type until `email_verified` came back boolean-true from whichever source
   * supplied the address (see {@link VerifiedEmail}). A caller holding these
   * claims may treat the email as proven.
   */
  email: string;
}

export interface McpWorkspaceRef {
  workspaceId: string;
  dbUrl: string;
}

export interface VerifyMcpTokenDeps {
  /**
   * Validate the JWT and return its subject (+ email if present), or null when
   * the token is well-formed but unusable (no subject). Throws on a cryptographic
   * or claim failure (bad signature, wrong issuer/audience, expiry) — the caller
   * treats a throw as "reject".
   */
  verifyJwt: (token: string) => Promise<VerifiedToken | null>;
  /** Resolve the caller's email — AND whether the directory considers it verified
   * (#1180) — from the subject (WorkOS user id), when the access token does not
   * carry an email claim. WorkOS access tokens carry only the subject, and the
   * control plane is keyed by the Google email, so this is the path production
   * actually takes. */
  resolveEmail: (subject: string) => Promise<VerifiedEmail | null>;
  /** Map verified claims to the caller's workspace, or null when no grant exists. */
  resolveWorkspace: (claims: McpTokenClaims) => Promise<McpWorkspaceRef | null>;
}

type JwtVerifierKey = CryptoKey | JWTVerifyGetKey;

/** Tolerated AS/resource-server clock drift (seconds) when checking `exp`/`nbf`. */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Build a `verifyJwt` from a key source (a static public key in tests, a remote
 * JWKS in production), the expected issuer, and the audience(s) — worthline's
 * RFC 8707 resource identifier(s), so a token minted for another resource is
 * rejected. `audience` may be a list: jose accepts the token when its `aud`
 * matches any one of them (see {@link acceptedAudiences}).
 * `algorithms` is **pinned** (no default): jose otherwise accepts whatever `alg`
 * the token header claims, opening an algorithm-confusion vector when a JWKS
 * hosts more than one key type.
 */
export function createJwtVerifier(config: {
  key: JwtVerifierKey;
  issuer: string;
  audience: string | string[];
  algorithms: string[];
}): (token: string) => Promise<VerifiedToken | null> {
  const getKey: JWTVerifyGetKey =
    typeof config.key === "function" ? config.key : async () => config.key as CryptoKey;

  return async (token) => {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: config.algorithms,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    const subject = typeof payload.sub === "string" ? payload.sub : null;
    if (!subject) {
      console.warn("[mcp-auth] token verified but has no subject", {
        aud: payload.aud,
        iss: payload.iss,
        claimKeys: Object.keys(payload),
      });
      return null;
    }
    const email = typeof payload["email"] === "string" ? payload["email"] : null;
    // Strict boolean-true only (#1180): `"true"`, `1` and an absent claim are all
    // "not verified", so a misconfigured AS cannot smuggle an unproven address in.
    return { subject, email, emailVerified: payload["email_verified"] === true };
  };
}

/**
 * The caller's email, or null when it cannot be established as VERIFIED (#1180).
 *
 * The token's own claim wins when present — and is then rejected outright if
 * unverified, rather than falling through to the directory: a token that asserts
 * an email must assert it as proven, and re-resolving would let a bad claim
 * silently succeed by another route. Only a token with NO email claim (the normal
 * WorkOS access token) reaches the directory.
 */
async function resolveVerifiedEmail(
  deps: VerifyMcpTokenDeps,
  verified: VerifiedToken,
): Promise<string | null> {
  const source: VerifiedEmail | null =
    verified.email === null
      ? await deps.resolveEmail(verified.subject)
      : { email: verified.email, emailVerified: verified.emailVerified };

  if (source === null) return null;
  if (!source.emailVerified) {
    // No PII: neither the address nor the subject is logged.
    console.warn("[mcp-auth] reject: the caller's email is not verified", {
      source: verified.email === null ? "directory" : "token_claim",
    });
    return null;
  }
  return source.email;
}

/** Compose the seams into the `(req, bearerToken) => AuthInfo | undefined` MCP verifier. */
export function createVerifyMcpToken(deps: VerifyMcpTokenDeps) {
  return async function verifyMcpToken(
    _req: Request,
    bearerToken?: string,
  ): Promise<AuthInfo | undefined> {
    if (!bearerToken) return undefined;

    let verified: VerifiedToken | null;
    try {
      verified = await deps.verifyJwt(bearerToken);
    } catch (error) {
      // Bad signature, wrong issuer/audience, or expired token → no auth → 401.
      const e = error as {
        code?: string;
        claim?: string;
        reason?: string;
        message?: string;
      };
      console.warn("[mcp-auth] reject: JWT validation failed", {
        code: e?.code,
        claim: e?.claim,
        reason: e?.reason,
        message: e?.message,
      });
      return undefined;
    }
    if (!verified) return undefined; // already logged by the verifier

    // WorkOS access tokens carry the subject but not the email; resolve it from
    // the WorkOS directory by subject when the token claim is absent (ADR 0034).
    // Either way the address must come back VERIFIED (#1180) — the tenant is
    // resolved by email, so an unproven one must never reach the control plane.
    const email = await resolveVerifiedEmail(deps, verified);
    if (!email) {
      // No PII: the subject/email values are deliberately not logged. The
      // unverified case logged its own, more specific reason above.
      console.warn(
        "[mcp-auth] reject: no verified email (token claim absent or unverified, and the directory supplied none)",
      );
      return undefined;
    }

    const workspace = await deps.resolveWorkspace({ subject: verified.subject, email });
    if (!workspace) {
      console.warn("[mcp-auth] reject: no granted workspace for the caller");
      return undefined;
    }

    return {
      token: bearerToken,
      clientId: verified.subject,
      scopes: [MCP_READ_SCOPE],
      extra: { workspaceId: workspace.workspaceId, dbUrl: workspace.dbUrl },
    };
  };
}

export function selectSingleMcpWorkspace(
  workspaces: McpWorkspaceRef[],
): McpWorkspaceRef | null {
  return workspaces.length === 1 ? workspaces[0]! : null;
}

type Env = Record<string, string | undefined>;

/**
 * Algorithms worthline accepts on a WorkOS-issued access token. WorkOS signs
 * with RS256; confirmed against the live JWKS.
 */
const ACCEPTED_TOKEN_ALGORITHMS = ["RS256"];

/**
 * The MCP endpoint path. Clients disagree on the RFC 8707 resource indicator for
 * this server: claude.ai and Claude Code use the origin advertised by
 * `/.well-known/oauth-protected-resource`, while others (e.g. Codex) use the full
 * endpoint URL. Both name the same resource.
 */
const MCP_ENDPOINT_PATH = "/api/mcp";

/**
 * The audiences worthline accepts on an access token: the resource origin and
 * the full MCP endpoint URL built from it. Accepting both keeps cross-resource
 * replay protection intact — a token minted for any *other* resource is still
 * rejected — while tolerating clients that compute the resource indicator either
 * way. The resource indicator must be registered in the Authorization Server for
 * each form a client may request (WorkOS MCP resource indicators).
 */
export function acceptedAudiences(resourceUrl: string): string[] {
  const origin = resourceUrl.replace(/\/+$/, "");
  return [origin, `${origin}${MCP_ENDPOINT_PATH}`];
}

/**
 * Cache the production verifier (and the remote JWKS object it closes over)
 * across requests, keyed by the env tuple — `createRemoteJWKSet` keeps its own
 * key cache with a TTL, so rebuilding it per request would drop that cache and
 * re-fetch the JWKS under load. Fail-closed is unaffected: nothing is cached
 * until all three env vars are present.
 */
let cachedJwtVerifier: { key: string; verify: VerifyMcpTokenDeps["verifyJwt"] } | null =
  null;

/** The production JWKS verifier, or null when the AS env is not configured. */
function envJwtVerifier(env: Env): VerifyMcpTokenDeps["verifyJwt"] | null {
  const jwksUrl = env["WORTHLINE_MCP_JWKS_URL"]?.trim();
  const issuer = env["WORTHLINE_MCP_AUTH_SERVER_URL"]?.trim();
  const audience = env["WORTHLINE_MCP_RESOURCE_URL"]?.trim();
  if (!jwksUrl || !issuer || !audience) return null;

  const cacheKey = `${jwksUrl}|${issuer}|${audience}`;
  if (cachedJwtVerifier?.key === cacheKey) return cachedJwtVerifier.verify;

  const verify = createJwtVerifier({
    key: createRemoteJWKSet(new URL(jwksUrl)),
    issuer,
    audience: acceptedAudiences(audience),
    algorithms: ACCEPTED_TOKEN_ALGORITHMS,
  });
  cachedJwtVerifier = { key: cacheKey, verify };
  return verify;
}

/**
 * Resolve the caller's verified email from the WorkOS User Management directory,
 * keyed by the token subject (the WorkOS user id) and authenticated with the
 * WorkOS secret API key. This is scope-independent — unlike OIDC userinfo it does
 * not depend on the access token carrying `openid` — so it works for the minimal
 * scopes an MCP client requests. The control plane is keyed by this email.
 *
 * `email_verified` travels with the address (#1180) instead of being assumed:
 * WorkOS returns it on the user object (snake_case over REST, camelCase via the
 * SDK — both are read). Only boolean-true counts as verified.
 */
async function envResolveEmail(subject: string, env: Env): Promise<VerifiedEmail | null> {
  const apiKey = env["WORKOS_API_KEY"]?.trim();
  if (!apiKey) {
    console.warn("[mcp-auth] no WORKOS_API_KEY: cannot resolve email from subject");
    return null;
  }
  try {
    const response = await fetch(
      `https://api.workos.com/user_management/users/${encodeURIComponent(subject)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!response.ok) {
      // No PII: the subject is deliberately not logged, only the HTTP status.
      console.warn("[mcp-auth] WorkOS user lookup failed", { status: response.status });
      return null;
    }
    const user = (await response.json()) as {
      email?: unknown;
      email_verified?: unknown;
      emailVerified?: unknown;
    };
    if (typeof user.email !== "string") return null;
    return {
      email: user.email,
      emailVerified: user.email_verified === true || user.emailVerified === true,
    };
  } catch (error) {
    console.warn("[mcp-auth] WorkOS user lookup errored", {
      message: (error as { message?: string })?.message,
    });
    return null;
  }
}

/** The production control-plane lookup: email → user → exactly one granted workspace. */
async function envResolveWorkspace(
  claims: McpTokenClaims,
  env: Env,
): Promise<McpWorkspaceRef | null> {
  const url = env["WORTHLINE_CONTROL_PLANE_DB_URL"]?.trim();
  if (!url) return null;
  const authToken = env["WORTHLINE_DB_AUTH_TOKEN"];
  const controlPlane: Pick<
    TenancyDirectory,
    "findUserByEmail" | "listWorkspacesForUser"
  > & { close(): void } = await createControlPlaneStore({
    url,
    ...(authToken ? { authToken } : {}),
  });
  try {
    const user = await controlPlane.findUserByEmail(claims.email);
    if (!user) return null;
    const workspaces = await controlPlane.listWorkspacesForUser(user.id);
    if (workspaces.length > 1) {
      console.warn("[mcp-auth] reject: caller has multiple granted workspaces", {
        workspaceCount: workspaces.length,
      });
    }
    const workspace = selectSingleMcpWorkspace(
      workspaces.map((entry) => ({
        workspaceId: entry.id,
        dbUrl: entry.dbUrl,
      })),
    );
    if (!workspace) return null;
    return workspace;
  } finally {
    controlPlane.close();
  }
}

/**
 * The production verifier wired into the `/api/mcp` route. Built per request from
 * env so a missing AS configuration **fails closed** (accepts nobody) rather than
 * crashing at module load — the local no-auth and demo paths never reach it.
 */
export async function verifyMcpToken(
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  const verifyJwt = envJwtVerifier(process.env);
  if (!verifyJwt) return undefined;
  return createVerifyMcpToken({
    verifyJwt,
    resolveEmail: (subject) => envResolveEmail(subject, process.env),
    resolveWorkspace: (claims) => envResolveWorkspace(claims, process.env),
  })(req, bearerToken);
}
