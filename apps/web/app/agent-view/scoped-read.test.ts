import { describe, expect, test, vi } from "vitest";

import { bindScope } from "./scoped-read";

/** A minimal read store exposing only the public-ID registry these tests touch. */
function fakeStore(
  rows: Array<{ entityType: string; entityId: string; publicId: string }>,
) {
  return {
    readPublicIds: vi.fn(async () => rows),
  } as never;
}

describe("bindScope", () => {
  test("carries the store and the public scope id as properties of one object", () => {
    const store = fakeStore([]);
    const scoped = bindScope(store, "wl_scp_home");

    expect(scoped.store).toBe(store);
    expect(scoped.scopeId).toBe("wl_scp_home");
  });

  test("resolves the bound scope's internal id through the shared registry lookup", async () => {
    const scoped = bindScope(
      fakeStore([{ entityType: "scope", entityId: "scope-1", publicId: "wl_scp_home" }]),
      "wl_scp_home",
    );

    expect(await scoped.internalScopeId()).toBe("scope-1");
  });

  test("an unknown scope is a 404, surfaced by the bound resolver (never a silent leak)", async () => {
    const scoped = bindScope(fakeStore([]), "wl_scp_missing");

    await expect(scoped.internalScopeId()).rejects.toMatchObject({ status: 404 });
  });
});
