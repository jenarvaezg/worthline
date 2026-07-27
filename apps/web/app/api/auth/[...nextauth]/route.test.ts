import { enforceMcpRateLimit } from "@web/api/mcp/rate-limit-store";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockGet = vi.fn(async () => new Response("ok-get", { status: 200 }));
const mockPost = vi.fn(async () => new Response("ok-post", { status: 200 }));

vi.mock("@web/auth", () => ({
  handlers: {
    GET: mockGet,
    POST: mockPost,
  },
}));

vi.mock("@web/api/mcp/rate-limit-store", () => ({
  enforceMcpRateLimit: vi.fn(),
}));

describe("Auth.js OAuth callback rate limit (#1183)", () => {
  const originalGoogleId = process.env.AUTH_GOOGLE_ID;
  const originalGoogleSecret = process.env.AUTH_GOOGLE_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enforceMcpRateLimit).mockResolvedValue("ok");
    process.env.AUTH_GOOGLE_ID = "test-google-id";
    process.env.AUTH_GOOGLE_SECRET = "test-google-secret";
  });

  afterEach(() => {
    if (originalGoogleId === undefined) {
      delete process.env.AUTH_GOOGLE_ID;
    } else {
      process.env.AUTH_GOOGLE_ID = originalGoogleId;
    }
    if (originalGoogleSecret === undefined) {
      delete process.env.AUTH_GOOGLE_SECRET;
    } else {
      process.env.AUTH_GOOGLE_SECRET = originalGoogleSecret;
    }
  });

  test("within the limit, the callback handler runs", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest("http://localhost:3000/api/auth/callback/google", {
        headers: { "x-real-ip": "203.0.113.30" },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(enforceMcpRateLimit).toHaveBeenCalledTimes(1);
  });

  test("over the limit, the callback is rejected before Auth.js runs", async () => {
    vi.mocked(enforceMcpRateLimit).mockResolvedValue("limited");
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost:3000/api/auth/callback/google", {
        method: "POST",
        headers: { "x-real-ip": "203.0.113.30" },
      }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(mockPost).not.toHaveBeenCalled();
  });

  test("store failure fails closed without invoking Auth.js", async () => {
    vi.mocked(enforceMcpRateLimit).mockResolvedValue("store_unavailable");
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest("http://localhost:3000/api/auth/callback/google", {
        headers: { "x-real-ip": "203.0.113.30" },
      }),
    );

    expect(response.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });
});
