import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

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
  afterEach(() => {
    delete process.env.AUTH_GOOGLE_ID;
    delete process.env.AUTH_GOOGLE_SECRET;
  });

  test("local no-auth mode disables Google sign-in and offers the local entry", async () => {
    const html = await renderToStaticMarkup(
      await LoginPage({
        searchParams: Promise.resolve({ returnTo: "/patrimonio" }),
      }),
    );

    expect(html).toContain("Iniciar sesión con Google");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Sesión local");
    expect(html).toContain('href="/patrimonio"');
  });

  test("hosted mode renders the live Google sign-in and never the local entry", async () => {
    process.env.AUTH_GOOGLE_ID = "test-id";
    process.env.AUTH_GOOGLE_SECRET = "test-secret";
    authMock.mockResolvedValue(null);

    const html = await renderToStaticMarkup(
      await LoginPage({ searchParams: Promise.resolve({ returnTo: "/app" }) }),
    );

    expect(html).toContain("Iniciar sesión con Google");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("Sesión local");
  });

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
