import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { createControlPlaneStore } from "@worthline/db";

/**
 * Resolve a bearer token presented to the agent-view MCP endpoint into the MCP
 * {@link AuthInfo} that identifies the caller's workspace (PRD #438, ADR 0034).
 *
 * The token is an OAuth access token the Authorization Server (WorkOS, S4)
 * issues after a Google login. Validation has two injectable seams so the unit
 * tests exercise the real logic with a locally-signed token and never contact
 * WorkOS: a `verifyJwt` (signature against the AS JWKS, issuer, audience, expiry
 * → claims) and a `resolveWorkspace` (claims → workspace via the control plane).
 *
 * The Turso group token that actually opens a workspace database is unrelated to
 * this OAuth token; it stays in env and is wired by the store seam (S3).
 */

export const MCP_READ_SCOPE = "worthline:read";

export interface McpTokenClaims {
  /** Stable subject from the Authorization Server (the WorkOS user id). */
  subject: string;
  /**
   * Email (Google federated), used to resolve the control-plane user.
   * INVARIANT: the Authorization Server MUST only mint tokens for *verified*
   * email addresses (Google is the verified upstream IdP, federated through
   * WorkOS — ADR 0034). If `email` is absent the token is rejected. The web
   * sign-in keys the control plane by the same Google email (ADR 0030), so MCP
   * and web resolve the same user.
   */
  email: string;
}

export interface McpWorkspaceRef {
  workspaceId: string;
  dbUrl: string;
}

export interface VerifyMcpTokenDeps {
  /**
   * Validate the JWT and return its claims, or null when the token is well-formed
   * but unusable (e.g. missing subject/email). Throws on a cryptographic or claim
   * failure (bad signature, wrong issuer/audience, expiry) — the caller treats a
   * throw as "reject".
   */
  verifyJwt: (token: string) => Promise<McpTokenClaims | null>;
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
}): (token: string) => Promise<McpTokenClaims | null> {
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
    const email = typeof payload["email"] === "string" ? payload["email"] : null;
    if (!subject || !email) return null;
    return { subject, email };
  };
}

/** Compose the two seams into the `(req, bearerToken) => AuthInfo | undefined` MCP verifier. */
export function createVerifyMcpToken(deps: VerifyMcpTokenDeps) {
  return async function verifyMcpToken(
    _req: Request,
    bearerToken?: string,
  ): Promise<AuthInfo | undefined> {
    if (!bearerToken) return undefined;

    let claims: McpTokenClaims | null;
    try {
      claims = await deps.verifyJwt(bearerToken);
    } catch {
      // Bad signature, wrong issuer/audience, or expired token → no auth → 401.
      return undefined;
    }
    if (!claims) return undefined;

    const workspace = await deps.resolveWorkspace(claims);
    if (!workspace) return undefined;

    return {
      token: bearerToken,
      clientId: claims.subject,
      scopes: [MCP_READ_SCOPE],
      extra: { workspaceId: workspace.workspaceId, dbUrl: workspace.dbUrl },
    };
  };
}

type Env = Record<string, string | undefined>;

/**
 * Algorithms worthline accepts on a WorkOS-issued access token. WorkOS signs
 * with RS256; S4's end-to-end validation against the real connector confirms it.
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
    resolveWorkspace: (claims) => envResolveWorkspace(claims, process.env),
  })(req, bearerToken);
}
