import type { StoreTarget } from "@web/store-resolver";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

let mockTarget: StoreTarget = { kind: "local" };

vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => mockTarget,
}));

import ViewingBanner from "./viewing-banner";

const OWN: StoreTarget = {
  dbUrl: "libsql://wl-leo.turso.io",
  kind: "authenticated",
  token: "full-leo",
  workspaceId: "ws_leo",
};

describe("ViewingBanner (#1844)", () => {
  test("names whose workspace the viewer is in, and that it is read-only", async () => {
    mockTarget = {
      dbUrl: "libsql://wl-ana.turso.io",
      kind: "authenticated",
      sharedByEmail: "ana@example.com",
      token: "read-only",
      workspaceId: "ws_ana",
    };

    const markup = renderToStaticMarkup(await ViewingBanner());

    expect(markup).toContain(
      "Estás viendo el espacio de <strong>ana@example.com</strong>",
    );
    expect(markup).toContain("Solo lectura");
  });

  test("its exit is a real form POSTing to /viewing/exit", async () => {
    mockTarget = { ...OWN, sharedByEmail: "ana@example.com", token: "read-only" };

    const markup = renderToStaticMarkup(await ViewingBanner());

    expect(markup).toContain('action="/viewing/exit"');
    expect(markup).toContain('method="post"');
    expect(markup).toContain("Volver a mi espacio");
  });

  test("is the neutral session band, not impersonation's gold: viewing is a legitimate state", async () => {
    mockTarget = { ...OWN, sharedByEmail: "ana@example.com", token: "read-only" };

    const markup = renderToStaticMarkup(await ViewingBanner());

    expect(markup).toContain('class="sessionBand"');
    expect(markup).not.toContain("data-tone");
  });

  test.each<[string, StoreTarget]>([
    ["one's own workspace", OWN],
    ["an admin impersonating", { ...OWN, impersonatedEmail: "ana@example.com" }],
    ["the demo", { kind: "demo", now: "", persona: "familia" }],
    ["local", { kind: "local" }],
    ["logged out", { kind: "unauthenticated" }],
  ])("renders nothing for %s", async (_label, target) => {
    mockTarget = target;
    expect(await ViewingBanner()).toBeNull();
  });
});
