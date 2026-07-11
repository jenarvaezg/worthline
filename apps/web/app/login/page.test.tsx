import { describe, expect, test, vi } from "vitest";

const { authMock, signInMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  signInMock: vi.fn(),
}));

vi.mock("@web/auth", () => ({
  auth: authMock,
  signIn: signInMock,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import LoginPage from "./page";

describe("LoginPage", () => {
  test("redirects an active session to a validated returnTo", async () => {
    process.env.AUTH_GOOGLE_ID = "test-id";
    process.env.AUTH_GOOGLE_SECRET = "test-secret";
    authMock.mockResolvedValue({ user: { email: "ana@example.com" } });

    await expect(
      LoginPage({ searchParams: Promise.resolve({ returnTo: "/patrimonio" }) }),
    ).rejects.toThrow("REDIRECT:/patrimonio");
  });

  test("rejects hostile returnTo and falls back to /app", async () => {
    process.env.AUTH_GOOGLE_ID = "test-id";
    process.env.AUTH_GOOGLE_SECRET = "test-secret";
    authMock.mockResolvedValue({ user: { email: "ana@example.com" } });

    await expect(
      LoginPage({
        searchParams: Promise.resolve({ returnTo: "https://evil.example.com/" }),
      }),
    ).rejects.toThrow("REDIRECT:/app");
  });
});
