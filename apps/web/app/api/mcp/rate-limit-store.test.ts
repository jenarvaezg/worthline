import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MCP_RATE_LIMITS } from "./rate-limit";
import { enforceMcpRateLimit } from "./rate-limit-store";

const recordMcpRequest = vi.fn();

vi.mock("@worthline/db", () => ({
  createControlPlaneStore: vi.fn(async () => ({
    recordMcpRequest,
    close: vi.fn(),
  })),
}));

describe("enforceMcpRateLimit", () => {
  const originalUrl = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;

  beforeEach(() => {
    recordMcpRequest.mockReset();
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://control-plane";
  });

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    } else {
      process.env.WORTHLINE_CONTROL_PLANE_DB_URL = originalUrl;
    }
  });

  test("within the limit passes", async () => {
    recordMcpRequest.mockResolvedValue(MCP_RATE_LIMITS.coarse);

    await expect(
      enforceMcpRateLimit({
        mode: "count",
        key: "mcp:ip:203.0.113.1",
        limit: MCP_RATE_LIMITS.coarse,
      }),
    ).resolves.toBe("ok");
  });

  test("over the limit rejects", async () => {
    recordMcpRequest.mockResolvedValue(MCP_RATE_LIMITS.coarse + 1);

    await expect(
      enforceMcpRateLimit({
        mode: "count",
        key: "mcp:ip:203.0.113.1",
        limit: MCP_RATE_LIMITS.coarse,
      }),
    ).resolves.toBe("limited");
  });

  test("store failure fails closed when the control plane is configured", async () => {
    recordMcpRequest.mockRejectedValue(new Error("db down"));

    await expect(
      enforceMcpRateLimit({
        mode: "count",
        key: "mcp:ip:203.0.113.1",
        limit: MCP_RATE_LIMITS.coarse,
      }),
    ).resolves.toBe("store_unavailable");
  });

  test("bypasses metering when no control-plane URL is configured", async () => {
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;

    await expect(
      enforceMcpRateLimit({
        mode: "count",
        key: "mcp:ip:203.0.113.1",
        limit: MCP_RATE_LIMITS.coarse,
      }),
    ).resolves.toBe("ok");
    expect(recordMcpRequest).not.toHaveBeenCalled();
  });
});
