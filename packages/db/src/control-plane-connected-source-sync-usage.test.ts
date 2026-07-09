import { describe, expect, it } from "vitest";

import { createInMemoryControlPlaneStore } from "./control-plane";

describe("control plane connected-source sync usage counter", () => {
  it("increments within the same key and window", async () => {
    const store = await createInMemoryControlPlaneStore();

    expect(await store.recordConnectedSourceSync("user:a", "2026-07-09T08")).toBe(1);
    expect(await store.recordConnectedSourceSync("user:a", "2026-07-09T08")).toBe(2);

    store.close();
  });

  it("counts users independently", async () => {
    const store = await createInMemoryControlPlaneStore();

    await store.recordConnectedSourceSync("user:a", "2026-07-09T08");

    expect(await store.recordConnectedSourceSync("user:b", "2026-07-09T08")).toBe(1);

    store.close();
  });
});
