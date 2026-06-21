import { afterEach, describe, expect, test } from "vitest";
import { SignJWT, generateKeyPair } from "jose";

import {
  createJwtVerifier,
  createVerifyMcpToken,
  MCP_READ_SCOPE,
  verifyMcpToken,
  type McpWorkspaceRef,
} from "./verify-token";

const ALG = "ES256";
const ISSUER = "https://auth.worthline.example";
const AUDIENCE = "https://worthline.example";
const REQUEST = new Request("https://worthline.example/api/mcp");

const ANA_WORKSPACE: McpWorkspaceRef = {
  workspaceId: "wl_ws_ana",
  dbUrl: "libsql://wl-ana.turso.io",
};

// The control-plane lookup, stubbed: only Ana has a granted workspace.
const resolveWorkspace = async (claims: {
  email: string;
}): Promise<McpWorkspaceRef | null> =>
  claims.email === "ana@example.com" ? ANA_WORKSPACE : null;

async function localKeys() {
  return generateKeyPair(ALG);
}

/**
 * A verifier wired like production but with a local public key. `resolveEmail`
 * defaults to "userinfo has nothing" so a token must carry its own email unless
 * a test supplies one.
 */
function buildVerify(
  publicKey: CryptoKey,
  resolveEmail: (accessToken: string) => Promise<string | null> = async () => null,
) {
  return createVerifyMcpToken({
    verifyJwt: createJwtVerifier({
      key: publicKey,
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALG],
    }),
    resolveEmail,
    resolveWorkspace,
  });
}

async function signToken(
  privateKey: CryptoKey,
  overrides: {
    /** `null` omits the email claim entirely (mirrors a WorkOS access token). */
    email?: string | null;
    subject?: string;
    issuer?: string;
    audience?: string;
    expirationTime?: string | number;
  } = {},
): Promise<string> {
  const payload =
    overrides.email === null ? {} : { email: overrides.email ?? "ana@example.com" };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.subject ?? "workos_user_ana")
    .setExpirationTime(overrides.expirationTime ?? "5m")
    .sign(privateKey);
}

describe("verifyMcpToken (injected JWKS verifier + userinfo + control-plane lookup)", () => {
  test("a token carrying an email claim resolves to the workspace without calling userinfo", async () => {
    const { publicKey, privateKey } = await localKeys();
    const resolveEmail = async () => {
      throw new Error("userinfo must not be called when the token carries email");
    };
    const auth = await buildVerify(publicKey, resolveEmail)(
      REQUEST,
      await signToken(privateKey),
    );

    expect(auth).toBeDefined();
    expect(auth?.scopes).toEqual([MCP_READ_SCOPE]);
    expect(auth?.clientId).toBe("workos_user_ana");
    expect(auth?.extra).toMatchObject({
      workspaceId: "wl_ws_ana",
      dbUrl: "libsql://wl-ana.turso.io",
    });
  });

  test("a token without an email claim resolves the email from userinfo (WorkOS access token)", async () => {
    const { publicKey, privateKey } = await localKeys();
    const resolveEmail = async () => "ana@example.com";
    const token = await signToken(privateKey, { email: null });
    const auth = await buildVerify(publicKey, resolveEmail)(REQUEST, token);

    expect(auth?.extra).toMatchObject({ workspaceId: "wl_ws_ana" });
  });

  test("a token without an email claim is rejected when userinfo provides none", async () => {
    const { publicKey, privateKey } = await localKeys();
    const token = await signToken(privateKey, { email: null });
    expect(await buildVerify(publicKey)(REQUEST, token)).toBeUndefined();
  });

  test("a missing bearer token is rejected (no auth → 401)", async () => {
    const { publicKey } = await localKeys();
    expect(await buildVerify(publicKey)(REQUEST, undefined)).toBeUndefined();
  });

  test("a token signed by a different key is rejected (bad signature)", async () => {
    const { publicKey } = await localKeys();
    const attacker = await localKeys();
    const forged = await signToken(attacker.privateKey);
    expect(await buildVerify(publicKey)(REQUEST, forged)).toBeUndefined();
  });

  test("a token minted for another audience is rejected (RFC 8707 replay guard)", async () => {
    const { publicKey, privateKey } = await localKeys();
    const wrongAudience = await signToken(privateKey, {
      audience: "https://someone-else.example",
    });
    expect(await buildVerify(publicKey)(REQUEST, wrongAudience)).toBeUndefined();
  });

  test("a token from another issuer is rejected", async () => {
    const { publicKey, privateKey } = await localKeys();
    const wrongIssuer = await signToken(privateKey, {
      issuer: "https://evil-issuer.example",
    });
    expect(await buildVerify(publicKey)(REQUEST, wrongIssuer)).toBeUndefined();
  });

  test("an expired token is rejected", async () => {
    const { publicKey, privateKey } = await localKeys();
    const expired = await signToken(privateKey, { expirationTime: "-5m" });
    expect(await buildVerify(publicKey)(REQUEST, expired)).toBeUndefined();
  });

  test("a valid token for a user with no granted workspace is rejected", async () => {
    const { publicKey, privateKey } = await localKeys();
    const ungranted = await signToken(privateKey, {
      email: "stranger@example.com",
      subject: "workos_user_stranger",
    });
    expect(await buildVerify(publicKey)(REQUEST, ungranted)).toBeUndefined();
  });
});

describe("verifyMcpToken (production wiring)", () => {
  const AS_ENV_KEYS = [
    "WORTHLINE_MCP_JWKS_URL",
    "WORTHLINE_MCP_AUTH_SERVER_URL",
    "WORTHLINE_MCP_RESOURCE_URL",
  ] as const;
  const original = AS_ENV_KEYS.map((key) => [key, process.env[key]] as const);

  afterEach(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("fails closed when the Authorization Server env is not configured", async () => {
    for (const key of AS_ENV_KEYS) delete process.env[key];

    const { privateKey } = await localKeys();
    // Even a token that would otherwise be well-formed is rejected: with no AS
    // configured the verifier accepts nobody rather than crashing.
    expect(await verifyMcpToken(REQUEST, await signToken(privateKey))).toBeUndefined();
  });
});
