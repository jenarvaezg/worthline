import { createInMemoryControlPlaneStore, type UsageLimits } from "@db/control-plane";
import { describe, expect, it } from "vitest";

type UsageLimitsStore = UsageLimits & { close(): void };

describe("control plane MCP usage counter", () => {
  it("increments atomically within the same key and window", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    expect(await store.recordMcpRequest("mcp:sub:user_a", "2026-07-04T10")).toBe(1);
    expect(await store.recordMcpRequest("mcp:sub:user_a", "2026-07-04T10")).toBe(2);
    expect(await store.recordMcpRequest("mcp:sub:user_a", "2026-07-04T10")).toBe(3);

    store.close();
  });

  it("counts keys and windows independently", async () => {
    const store: UsageLimitsStore = await createInMemoryControlPlaneStore();

    await store.recordMcpRequest("mcp:ip:1.2.3.4", "2026-07-04T10");
    await store.recordMcpRequest("mcp:ip:1.2.3.4", "2026-07-04T10");

    expect(await store.recordMcpRequest("mcp:sub:user_b", "2026-07-04T10")).toBe(1);
    expect(await store.recordMcpRequest("mcp:ip:1.2.3.4", "2026-07-04T11")).toBe(1);

    store.close();
  });
});
