/**
 * The pageShell seam (#1118): the one preamble every workspace RSC page runs
 * before its own reads. These tests pin the contract the ten pages rely on:
 * target → healthcheck → cookies → store → workspace (onboarding redirect) →
 * scope options → selected scope → privacy.
 */
import type { Workspace } from "@worthline/domain";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => {
  const state = {
    cookies: {} as Record<string, string>,
    workspace: null as unknown,
  };
  const target = { kind: "local" as const };
  const persistence = {
    status: "ok" as const,
    checkKey: "bootstrap.last_healthcheck_at",
    checkedAt: "2026-07-19T00:00:00.000Z",
    checkValue: "2026-07-19T00:00:00.000Z",
    databasePath: ":memory:",
    displayPath: ":memory:",
  };
  const store = {
    workspace: { readWorkspace: vi.fn(async () => state.workspace) },
  };
  return {
    bootstrapHealthcheck: vi.fn(async () => persistence),
    getRequestStore: vi.fn(async () => store),
    persistence,
    requireStoreTarget: vi.fn(async () => target),
    state,
    store,
    target,
  };
});

vi.mock("@web/read-store-target", () => ({
  requireStoreTarget: calls.requireStoreTarget,
}));

vi.mock("@web/store", () => ({
  bootstrapHealthcheck: calls.bootstrapHealthcheck,
  getRequestStore: calls.getRequestStore,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      calls.state.cookies[name] === undefined
        ? undefined
        : { value: calls.state.cookies[name] },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

import { resolvePageShell } from "./page-shell";

const householdWorkspace: Workspace = {
  baseCurrency: "EUR",
  groups: [],
  members: [
    { id: "member_jose", name: "Jose" },
    { id: "member_ana", name: "Ana" },
  ],
  mode: "household",
} as unknown as Workspace;

function setUp(input: { cookies?: Record<string, string>; workspace?: unknown } = {}) {
  calls.state.cookies = input.cookies ?? {};
  calls.state.workspace = "workspace" in input ? input.workspace : householdWorkspace;
}

describe("resolvePageShell", () => {
  test("resolves the full preamble: target, healthcheck pinned to it, store, workspace", async () => {
    setUp();

    const shell = await resolvePageShell();

    expect(shell.target).toBe(calls.target);
    // The healthcheck reuses the already-resolved target — no second resolve.
    expect(calls.bootstrapHealthcheck).toHaveBeenCalledWith(calls.target);
    expect(shell.persistence).toBe(calls.persistence);
    expect(shell.store).toBe(calls.store);
    expect(shell.workspace).toBe(householdWorkspace);
  });

  test("defaults to the first scope with no cookie and no privacy", async () => {
    setUp();

    const shell = await resolvePageShell();

    expect(shell.scopes.map((scope) => scope.id)).toEqual([
      "household",
      "member_jose",
      "member_ana",
    ]);
    expect(shell.selectedScope?.id).toBe("household");
    expect(shell.requestedScopeId).toBeUndefined();
    expect(shell.privacyMode).toBe(false);
  });

  test("selects the scope from the cookie and parses the privacy cookie", async () => {
    setUp({ cookies: { wl_scope: "member_ana", wl_privacy: "1" } });

    const shell = await resolvePageShell();

    expect(shell.selectedScope?.id).toBe("member_ana");
    expect(shell.requestedScopeId).toBe("member_ana");
    expect(shell.privacyMode).toBe(true);
  });

  test("lets ?scope= in the URL override the cookie", async () => {
    setUp({ cookies: { wl_scope: "member_ana" } });

    const shell = await resolvePageShell({
      searchParams: { scope: "member_jose" },
    });

    expect(shell.selectedScope?.id).toBe("member_jose");
    expect(shell.requestedScopeId).toBe("member_jose");
  });

  test("falls back to the first scope when the requested scope is unknown", async () => {
    setUp({ cookies: { wl_scope: "member_gone" } });

    const shell = await resolvePageShell();

    expect(shell.selectedScope?.id).toBe("household");
    // The raw request is still exposed — the dashboard passes it downstream.
    expect(shell.requestedScopeId).toBe("member_gone");
  });

  test("redirects to onboarding when the store has no workspace yet", async () => {
    setUp({ workspace: null });

    await expect(resolvePageShell()).rejects.toThrow("redirected to /empezar");
  });
});
