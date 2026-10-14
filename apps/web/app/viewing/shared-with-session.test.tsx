/**
 * The «Compartidos contigo» entry of /bienvenida (#1844): someone who was only
 * invited lands on onboarding after their first sign-in, so the way into the
 * workspace shared with them has to be there too.
 */
import type { StoreTarget } from "@web/store-resolver";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

const OWN: StoreTarget = {
  dbUrl: "libsql://wl-leo.turso.io",
  kind: "authenticated",
  token: "full-leo",
  workspaceId: "ws_leo",
};

let mockTarget: StoreTarget = OWN;
vi.mock("@web/read-store-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@web/read-store-target")>()),
  readSessionEmail: async () => "leo@example.com",
  readStoreTarget: async () => mockTarget,
}));

const load = vi.hoisted(() =>
  vi.fn(async (_email: string) => ({
    sharedWithMe: [
      {
        createdAt: "2026-10-02 08:00:00",
        ownerEmail: "ana@example.com",
        workspaceId: "ws_ana",
      },
    ],
    viewers: [],
  })),
);
vi.mock("@web/sharing/sharing-control-plane", () => ({ loadWorkspaceSharing: load }));

import SharedWithSession from "./shared-with-session";

afterEach(() => {
  mockTarget = OWN;
  load.mockClear();
});

describe("SharedWithSession (#1844)", () => {
  test("offers the session's identity the workspaces shared with it", async () => {
    const html = renderToStaticMarkup(await SharedWithSession());

    expect(load).toHaveBeenCalledWith("leo@example.com");
    expect(html).toContain("Compartidos contigo");
    expect(html).toContain("ana@example.com");
    expect(html).toContain('action="/viewing"');
  });

  test.each<[string, StoreTarget]>([
    ["the demo", { kind: "demo", now: "", persona: "familia" }],
    ["an admin impersonating", { ...OWN, impersonatedEmail: "ana@example.com" }],
    ["local no-auth mode", { kind: "local" }],
  ])("%s gets nothing, and nothing is read", async (_label, target) => {
    mockTarget = target;

    expect(await SharedWithSession()).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
