import type { StoreTarget } from "@web/store-resolver";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

let mockTarget: StoreTarget = { kind: "local" };

vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => mockTarget,
}));

import ImpersonationBanner from "./impersonation-banner";

describe("ImpersonationBanner", () => {
  test("shows who the admin is viewing as, with an exit control that POSTs to stop impersonation", async () => {
    mockTarget = {
      kind: "authenticated",
      workspaceId: "ws-target",
      dbUrl: "libsql://wl-target.turso.io",
      token: "token",
      impersonatedEmail: "target@example.com",
    };

    const markup = renderToStaticMarkup(await ImpersonationBanner());

    expect(markup).toContain("target@example.com");
    expect(markup).toContain("solo lectura");
    expect(markup).toContain("Salir");
  });

  test("renders nothing for an ordinary authenticated (non-impersonated) target", async () => {
    mockTarget = {
      kind: "authenticated",
      workspaceId: "ws-ana",
      dbUrl: "libsql://wl-ana.turso.io",
      token: "token",
    };

    expect(await ImpersonationBanner()).toBeNull();
  });

  test("renders nothing for the demo", async () => {
    mockTarget = { kind: "demo", persona: "familia", now: "" };
    expect(await ImpersonationBanner()).toBeNull();
  });

  test("renders nothing when logged out", async () => {
    mockTarget = { kind: "unauthenticated" };
    expect(await ImpersonationBanner()).toBeNull();
  });
});
