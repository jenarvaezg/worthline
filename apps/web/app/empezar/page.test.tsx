/**
 * /empezar for someone who was only invited (#1844, ADR 0112). A new identity's
 * own workspace is provisioned empty on its first sign-in, so `/app` sends it
 * here — and here is where the way into what was shared with it has to be, or
 * it never sees «Compartidos contigo». The creation paths stay: the workspace is
 * still theirs to start.
 */

import type { StoreTarget } from "@web/store-resolver";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const OWN: StoreTarget = {
  dbUrl: "libsql://wl-leo.turso.io",
  kind: "authenticated",
  token: "full-leo",
  workspaceId: "ws_leo",
};

const state = vi.hoisted(() => ({
  target: null as unknown,
}));

vi.mock("@web/read-store-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@web/read-store-target")>()),
  readSessionEmail: async () => "leo@example.com",
  readStoreTarget: async () => state.target,
}));
vi.mock("@web/store", () => ({
  withStore: async (run: (store: unknown) => unknown) =>
    run({ workspace: { readWorkspace: async () => null } }),
}));
vi.mock("@web/feedback/feedback-mount", () => ({ default: () => null }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
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

import EmpezarPage from "./page";

async function render(): Promise<string> {
  return renderToStaticMarkup(await EmpezarPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  state.target = OWN;
  load.mockClear();
});

describe("/empezar · «Compartidos contigo» for the invited (#1844)", () => {
  test("someone with a workspace shared with them sees the way in, beside the creation paths", async () => {
    const html = await render();

    expect(load).toHaveBeenCalledWith("leo@example.com");
    expect(html).toContain("Compartidos contigo");
    expect(html).toContain("ana@example.com");
    expect(html).toContain('action="/viewing"');
    expect(html).toContain('name="workspaceId" value="ws_ana"');
    expect(html).toContain("Empezar solo");
  });

  test("with nothing shared, the page is the creation form alone", async () => {
    load.mockResolvedValueOnce({ sharedWithMe: [], viewers: [] });

    const html = await render();

    expect(html).not.toContain("Compartidos contigo");
    expect(html).toContain("Empezar solo");
  });

  test("local no-auth mode has no identity to list for, and reads nothing", async () => {
    state.target = { kind: "local" };

    const html = await render();

    expect(load).not.toHaveBeenCalled();
    expect(html).not.toContain("Compartidos contigo");
    expect(html).toContain("Empezar solo");
  });
});
