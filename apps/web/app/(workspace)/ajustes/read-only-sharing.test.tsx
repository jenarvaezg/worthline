/**
 * Who sees the sharing sections of /ajustes (#1844). Only a session acting on its
 * own account: the demo, an admin impersonating and a viewer never see a sharing
 * control — and the control plane is not even read for them — and neither does
 * local no-auth mode, which has no account to share from.
 */
import type { StoreTarget } from "@web/store-resolver";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

const OWN: StoreTarget = {
  dbUrl: "libsql://wl-jose.turso.io",
  kind: "authenticated",
  token: "full-jose",
  workspaceId: "ws_jose",
};

let mockTarget: StoreTarget = OWN;
let mockSessionEmail: string | null = "jose@example.com";
vi.mock("@web/read-store-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@web/read-store-target")>()),
  readSessionEmail: async () => mockSessionEmail,
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
    viewers: [
      { createdAt: "2026-10-01 09:30:00", email: "luis@example.com", userId: "u_luis" },
    ],
  })),
);
vi.mock("@web/sharing/sharing-control-plane", () => ({ loadWorkspaceSharing: load }));

import { readOnlySharingSections } from "./read-only-sharing";

afterEach(() => {
  mockTarget = OWN;
  mockSessionEmail = "jose@example.com";
  load.mockClear();
});

async function render(): Promise<string> {
  return renderToStaticMarkup(
    await readOnlySharingSections({ formError: null, today: "2026-10-14" }),
  );
}

describe("the sharing sections of /ajustes (#1844)", () => {
  test("the owner sees who views their workspace, and the workspaces shared with them", async () => {
    const html = await render();

    expect(load).toHaveBeenCalledWith("jose@example.com");
    expect(html).toContain("Acceso de solo lectura");
    expect(html).toContain("luis@example.com");
    expect(html).toContain("Compartidos contigo");
    expect(html).toContain("ana@example.com");
  });

  test("a refused no-JS share lands in the section, with what was typed", async () => {
    const html = renderToStaticMarkup(
      await readOnlySharingSections({
        formError: {
          formId: "readOnlyAccess",
          message: "Esa persona ya tiene acceso.",
          values: { viewerEmail: "luis@example.com" },
        },
        today: "2026-10-14",
      }),
    );

    expect(html).toContain(
      '<p class="formError" role="alert">Esa persona ya tiene acceso.</p>',
    );
    expect(html).toContain('value="luis@example.com"');
  });

  test.each<[string, StoreTarget]>([
    ["the demo", { kind: "demo", now: "", persona: "familia" }],
    ["an admin impersonating", { ...OWN, impersonatedEmail: "ana@example.com" }],
    ["a viewer", { ...OWN, sharedByEmail: "ana@example.com", token: "read-only" }],
    ["local no-auth mode", { kind: "local" }],
  ])("%s sees no sharing section, and nothing is read", async (_label, target) => {
    mockTarget = target;

    expect(
      await readOnlySharingSections({ formError: null, today: "2026-10-14" }),
    ).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  test("a session with no email has no account to share from", async () => {
    mockSessionEmail = null;

    expect(
      await readOnlySharingSections({ formError: null, today: "2026-10-14" }),
    ).toBeNull();
  });
});
