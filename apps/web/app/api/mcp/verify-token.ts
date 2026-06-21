import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { createControlPlaneStore } from "@worthline/db";

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
}

export interface McpTokenClaims {
  subject: string;
  /**
   * Verified email (Google federated), used to resolve the control-plane user.
   * INVARIANT: the Authorization Server MUST only expose verified email
   * addresses (Google is the verified upstream IdP via WorkOS — ADR 0034). The
   * web sign-in keys the control plane by the same Google email (ADR 0030), so
   * MCP and web resolve the same user.
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
  /** Resolve the caller's verified email from the subject (WorkOS user id) when
   * the access token does not carry an email claim — WorkOS access tokens carry
   * only the subject, and the control plane is keyed by the Google email. */
  resolveEmail: (subject: string) => Promise<string | null>;
  /** Map verified claims to the caller's workspace, or null when no grant exists. */
  resolveWorkspace: (claims: McpTokenClaims) => Promise<McpWorkspaceRef | null>;
}

type JwtVerifierKey = CryptoKey | JWTVerifyGetKey;

/** Tolerated AS/resource-server clock drift (seconds) when checking `exp`/`nbf`. */
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * Build a `verifyJwt` from a key source (a static public key in tests, a remote
 * JWKS in production), the expected issuer, and the audience — worthline's RFC
 * 8707 resource identifier, so a token minted for another audience is rejected.
 * `algorithms` is **pinned** (no default): jose otherwise accepts whatever `alg`
 * the token header claims, opening an algorithm-confusion vector when a JWKS
 * hosts more than one key type.
 */
export function createJwtVerifier(config: {
  key: JwtVerifierKey;
  issuer: string;
  audience: string;
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
    return { subject, email };
  };
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
    const email = verified.email ?? (await deps.resolveEmail(verified.subject));
    if (!email) {
      console.warn(
        "[mcp-auth] reject: no email (token claim absent and userinfo returned none)",
        { sub: verified.subject },
      );
      return undefined;
    }

    const workspace = await deps.resolveWorkspace({ subject: verified.subject, email });
    if (!workspace) {
      console.warn("[mcp-auth] reject: no granted workspace for token", { email });
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

type Env = Record<string, string | undefined>;

/**
 * Algorithms worthline accepts on a WorkOS-issued access token. WorkOS signs
 * with RS256; confirmed against the live JWKS.
 */
const ACCEPTED_TOKEN_ALGORITHMS = ["RS256"];

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
    audience,
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
 */
async function envResolveEmail(subject: string, env: Env): Promise<string | null> {
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
      console.warn("[mcp-auth] WorkOS user lookup failed", {
        status: response.status,
        subject,
      });
      return null;
    }
    const user = (await response.json()) as { email?: unknown };
    return typeof user.email === "string" ? user.email : null;
  } catch (error) {
    console.warn("[mcp-auth] WorkOS user lookup errored", {
      message: (error as { message?: string })?.message,
    });
    return null;
  }
}

/** The production control-plane lookup: email → user → first granted workspace. */
async function envResolveWorkspace(
  claims: McpTokenClaims,
  env: Env,
): Promise<McpWorkspaceRef | null> {
  const url = env["WORTHLINE_CONTROL_PLANE_DB_URL"]?.trim();
  if (!url) return null;
  const authToken = env["WORTHLINE_DB_AUTH_TOKEN"];
  const controlPlane = await createControlPlaneStore({
    url,
    ...(authToken ? { authToken } : {}),
  });
  try {
    const user = await controlPlane.findUserByEmail(claims.email);
    if (!user) return null;
    const workspaces = await controlPlane.listWorkspacesForUser(user.id);
    const workspace = workspaces[0];
    if (!workspace) return null;
    return { workspaceId: workspace.id, dbUrl: workspace.dbUrl };
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
