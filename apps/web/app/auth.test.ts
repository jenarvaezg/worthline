import type { NextAuthConfig } from "next-auth";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * The Auth.js callbacks that decide a sign-in (#1175). NextAuth itself is
 * replaced by a stub that hands back the config, so the callbacks run exactly
 * as Auth.js would call them, with provisioning mocked at its seam.
 */
const { captured, admitSignInMock, workspaceForTokenMock, FakeAuthError } = vi.hoisted(
  () => {
    class FakeAuthError extends Error {}
    return {
      admitSignInMock: vi.fn(),
      captured: { config: null as NextAuthConfig | null },
      FakeAuthError,
      workspaceForTokenMock: vi.fn(),
    };
  },
);

vi.mock("next-auth", () => ({
  AuthError: FakeAuthError,
  default: (config: NextAuthConfig) => {
    captured.config = config;
    return { auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() };
  },
}));

vi.mock("@web/provisioning", () => ({
  admitSignIn: admitSignInMock,
  workspaceForSessionToken: workspaceForTokenMock,
}));

await import("./auth");

type SignInArgs = Parameters<
  NonNullable<NonNullable<NextAuthConfig["callbacks"]>["signIn"]>
>[0];

function signIn(args: Partial<SignInArgs>) {
  const callback = captured.config?.callbacks?.signIn;
  if (!callback) throw new Error("auth.ts must declare a signIn callback");
  return callback(args as SignInArgs);
}

const GOOGLE_ACCOUNT = { provider: "google", providerAccountId: "123", type: "oauth" };

describe("auth.ts · signIn (#1175)", () => {
  afterEach(() => {
    admitSignInMock.mockReset();
  });

  test("lets an admitted identity through", async () => {
    admitSignInMock.mockResolvedValue(true);
    await expect(
      signIn({ account: GOOGLE_ACCOUNT as never, user: { email: "ana@example.com" } }),
    ).resolves.toBe(true);
    expect(admitSignInMock).toHaveBeenCalledWith("ana@example.com");
  });

  test("redirects a refused sign-up to the path the admission names", async () => {
    admitSignInMock.mockResolvedValue("/login?registro=lleno");
    await expect(
      signIn({ account: GOOGLE_ACCOUNT as never, user: { email: "leo@example.com" } }),
    ).resolves.toBe("/login?registro=lleno");
  });

  test("a real provisioning failure is an AuthError, not an «access denied» lie", async () => {
    // Auth.js turns a plain throw from `signIn` into AccessDenied («no tienes
    // permiso»). An AuthError lands on the server-error page instead — what a
    // provisioning failure always showed before the gate moved into `signIn`.
    admitSignInMock.mockRejectedValue(new Error("Turso Platform API unavailable"));
    await expect(
      signIn({ account: GOOGLE_ACCOUNT as never, user: { email: "ana@example.com" } }),
    ).rejects.toBeInstanceOf(FakeAuthError);
  });

  test("a sign-in with no email never reaches provisioning", async () => {
    await expect(signIn({ account: GOOGLE_ACCOUNT as never, user: {} })).resolves.toBe(
      true,
    );
    expect(admitSignInMock).not.toHaveBeenCalled();
  });
});

type JwtArgs = Parameters<
  NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>
>[0];

function jwt(args: Partial<JwtArgs>) {
  const callback = captured.config?.callbacks?.jwt;
  if (!callback) throw new Error("auth.ts must declare a jwt callback");
  return callback(args as JwtArgs);
}

describe("auth.ts · jwt (#1175)", () => {
  afterEach(() => {
    workspaceForTokenMock.mockReset();
  });

  test("pins the workspace of the sign-in into the token", async () => {
    workspaceForTokenMock.mockResolvedValue({
      dbAuthToken: "scoped",
      dbUrl: "libsql://ws",
      id: "ws-ana",
    });
    const token = await jwt({
      account: GOOGLE_ACCOUNT as never,
      token: { email: "ana@example.com" },
    });
    expect(workspaceForTokenMock).toHaveBeenCalledWith("ana@example.com");
    expect(token).toMatchObject({
      dbAuthToken: "scoped",
      dbUrl: "libsql://ws",
      workspaceId: "ws-ana",
    });
  });

  test("an ordinary session refresh (no account) resolves nothing", async () => {
    const token = await jwt({
      token: { email: "ana@example.com", workspaceId: "ws-ana" },
    });
    expect(workspaceForTokenMock).not.toHaveBeenCalled();
    expect(token).toMatchObject({ workspaceId: "ws-ana" });
  });
});
