/**
 * Wiring suite: setScopeAction (app/actions/scope.ts).
 *
 * setScopeAction writes a cookie via next/headers and redirects.
 * next/headers is stubbed with a minimal cookie jar so the test runs
 * without a Next.js runtime.  next/cache is stubbed for completeness.
 *
 * We only assert the redirect destination — cookie behavior is an
 * implementation detail of the framework stub.
 */

import { vi, describe, test, expect } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Stub next/headers: cookies() returns a minimal jar with a set() spy.
// vi.hoisted so the spy exists when the hoisted vi.mock factory runs.
const cookieSetSpy = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({ set: cookieSetSpy }),
}));

import { setScopeAction } from "../apps/web/app/actions/scope";

// ------------------------------------------------------------------ helpers --

function catchRedirect(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => {
      throw new Error("Expected redirect but action returned normally");
    },
    (err: unknown) => {
      if (err instanceof Error && (err.message === "NEXT_REDIRECT" || "digest" in err)) {
        const digest = (err as { digest?: string }).digest ?? "";
        const parts = digest.split(";");
        return parts[2] ?? digest;
      }
      throw err;
    },
  );
}

function fd(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

// ================================================================ setScopeAction

describe("setScopeAction wiring", () => {
  test("happy path: redirects back to returnTo path", async () => {
    const url = await catchRedirect(() =>
      setScopeAction(fd({ scopeId: "member_ana", returnTo: "/patrimonio" })),
    );

    expect(url).toBe("/patrimonio");
  });

  test("sets the scope cookie when scopeId is present", async () => {
    cookieSetSpy.mockClear();

    await catchRedirect(() =>
      setScopeAction(fd({ scopeId: "member_jose", returnTo: "/" })),
    );

    expect(cookieSetSpy).toHaveBeenCalledWith(
      "wl_scope",
      "member_jose",
      expect.objectContaining({ httpOnly: true }),
    );
  });

  test("blank scopeId: still redirects, skips setting cookie", async () => {
    cookieSetSpy.mockClear();

    const url = await catchRedirect(() =>
      setScopeAction(fd({ scopeId: "", returnTo: "/inversiones" })),
    );

    expect(url).toBe("/inversiones");
    expect(cookieSetSpy).not.toHaveBeenCalled();
  });

  test("unsafe returnTo (absolute URL): redirects to /", async () => {
    const url = await catchRedirect(() =>
      setScopeAction(fd({ scopeId: "member_ana", returnTo: "//evil.com/steal" })),
    );

    expect(url).toBe("/");
  });

  test("missing returnTo: redirects to /", async () => {
    const url = await catchRedirect(() =>
      setScopeAction(fd({ scopeId: "member_ana" })),
    );

    expect(url).toBe("/");
  });
});
