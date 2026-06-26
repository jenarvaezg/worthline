/**
 * /empezar action tests (S4, #599). The solo/hogar onboarding actions create the
 * workspace through the shared store seam and then chain straight into the add
 * wizard — first run is one continuous path, never a drop onto an empty
 * dashboard. These assert the workspace shape AND the post-creation redirect
 * target.
 */
import { createInMemoryStore } from "@worthline/db";
import type { WorthlineStore } from "@worthline/db";
import { describe, expect, test, vi } from "vitest";

import { initHogarAction, initSoloAction } from "./actions";

vi.mock("@web/demo/write-guard", () => ({
  guardDemoWrite: vi.fn(async () => undefined),
}));

// The solo action sets the scope cookie; the hogar action only reads (none).
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
  }),
}));

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/** Invoke an action (which always throws redirect()) and return the URL digest. */
async function runAction(
  action: (fd: FormData, store: WorthlineStore) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
): Promise<string> {
  try {
    await action(fd, store);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

describe("initSoloAction (#599)", () => {
  test("creates an individual workspace and chains into the add wizard", async () => {
    const store = await createInMemoryStore();

    const url = await runAction(initSoloAction, form({ name: "Ana" }), store);

    expect(url).toContain("/patrimonio/anadir");

    const workspace = await store.workspace.readWorkspace();
    expect(workspace?.mode).toBe("individual");
    expect(workspace?.members.map((m) => m.name)).toEqual(["Ana"]);
  });
});

describe("initHogarAction (#599)", () => {
  test("creates a household workspace and chains into the add wizard", async () => {
    const store = await createInMemoryStore();

    const url = await runAction(
      initHogarAction,
      form({ memberNames: "Ana\nJose" }),
      store,
    );

    expect(url).toContain("/patrimonio/anadir");

    const workspace = await store.workspace.readWorkspace();
    expect(workspace?.mode).toBe("household");
    expect(workspace?.members.map((m) => m.name)).toEqual(["Ana", "Jose"]);
  });
});
