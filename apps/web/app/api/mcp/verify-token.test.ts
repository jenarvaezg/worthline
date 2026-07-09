import { generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, test } from "vitest";

import {
  acceptedAudiences,
  createJwtVerifier,
  createVerifyMcpToken,
  MCP_READ_SCOPE,
  type McpWorkspaceRef,
  selectSingleMcpWorkspace,
  verifyMcpToken,
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
 * defaults to "the directory has nothing" so a token must carry its own email
 * unless a test supplies one.
 */
function buildVerify(
  publicKey: CryptoKey,
  resolveEmail: (subject: string) => Promise<string | null> = async () => null,
) {
  return createVerifyMcpToken({
    verifyJwt: createJwtVerifier({
      key: publicKey,
      issuer: ISSUER,
      audience: acceptedAudiences(AUDIENCE),
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

describe("verifyMcpToken (injected JWKS verifier + directory + control-plane lookup)", () => {
  test("a token carrying an email claim resolves to the workspace without a directory lookup", async () => {
    const { publicKey, privateKey } = await localKeys();
    const resolveEmail = async () => {
      throw new Error("the directory must not be queried when the token carries email");
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

  test("a token without an email claim resolves the email from the directory by subject (WorkOS access token)", async () => {
    const { publicKey, privateKey } = await localKeys();
    // The directory is keyed by the token subject (the WorkOS user id).
    const resolveEmail = async (subject: string) =>
      subject === "workos_user_ana" ? "ana@example.com" : null;
    const token = await signToken(privateKey, { email: null });
    const auth = await buildVerify(publicKey, resolveEmail)(REQUEST, token);

    expect(auth?.extra).toMatchObject({ workspaceId: "wl_ws_ana" });
  });

  test("a token without an email claim is rejected when the directory provides none", async () => {
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

  test("a token whose audience is the full MCP endpoint URL is accepted (Codex resource form)", async () => {
    const { publicKey, privateKey } = await localKeys();
    // claude.ai/Claude Code use the origin; Codex uses the full endpoint URL.
    // Both name this same server, so both are valid audiences.
    const endpointAudience = await signToken(privateKey, {
      audience: `${AUDIENCE}/api/mcp`,
    });
    const auth = await buildVerify(publicKey)(REQUEST, endpointAudience);
    expect(auth?.extra).toMatchObject({ workspaceId: "wl_ws_ana" });
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

describe("acceptedAudiences", () => {
  test("accepts both the origin and the full MCP endpoint URL", () => {
    expect(acceptedAudiences("https://worthline.example")).toEqual([
      "https://worthline.example",
      "https://worthline.example/api/mcp",
    ]);
  });

  test("ignores a trailing slash on the resource origin", () => {
    expect(acceptedAudiences("https://worthline.example/")).toEqual([
      "https://worthline.example",
      "https://worthline.example/api/mcp",
    ]);
  });
});

describe("selectSingleMcpWorkspace", () => {
  test("returns the only granted workspace", () => {
    expect(selectSingleMcpWorkspace([ANA_WORKSPACE])).toBe(ANA_WORKSPACE);
  });

  test("rejects absent or ambiguous workspace grants instead of picking the first", () => {
    expect(selectSingleMcpWorkspace([])).toBeNull();
    expect(
      selectSingleMcpWorkspace([
        ANA_WORKSPACE,
        { workspaceId: "wl_ws_leo", dbUrl: "libsql://wl-leo.turso.io" },
      ]),
    ).toBeNull();
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
