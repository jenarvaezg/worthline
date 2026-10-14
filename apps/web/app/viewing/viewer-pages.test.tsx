/**
 * The pages closed to a viewer, refused on the server (#1843, ADR 0112):
 * `/ajustes` and `/ajustes/conexiones` (members, reset, import, connections, the
 * list of viewers — the owner's) and `/bienvenida` (the owner's onboarding) send
 * it to `/app`; `/premium/pagar` sends it back to `/premium` without creating a
 * checkout for the owner's workspace; and `/empezar`, where `/app` sends an
 * empty workspace, shows a static notice with the way out instead of the
 * creation form — otherwise `/app` ↔ `/empezar` would loop.
 */

import type { StoreTarget } from "@web/store-resolver";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  checkoutUrl: vi.fn(async () => "https://checkout.example/txn"),
  resolvePageShell: vi.fn(async () => {
    throw new Error("the page shell must not be resolved for a viewer");
  }),
  target: null as unknown,
  workspace: null as unknown,
}));

vi.mock("@web/read-store-target", () => ({
  readSessionEmail: async () => "lucia@example.com",
  readStoreTarget: async () => state.target,
}));
vi.mock("@web/page-shell", () => ({ resolvePageShell: state.resolvePageShell }));
vi.mock("@web/store", () => ({
  withStore: async (run: (store: unknown) => unknown) =>
    run({ workspace: { readWorkspace: async () => state.workspace } }),
}));
vi.mock("@web/billing/get-billing-adapter", () => ({
  getBillingAdapter: () => ({
    checkoutUrl: state.checkoutUrl,
    offersTier: () => true,
  }),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirected to ${url}`);
  },
}));

import { ConexionesContent } from "@web/ajustes/conexiones/page";
import { AjustesContent } from "@web/ajustes/page";
import BienvenidaPage from "@web/bienvenida/page";
import EmpezarPage from "@web/empezar/page";
import { PagarContent } from "@web/premium/pagar/page";

const VIEWER: StoreTarget = {
  kind: "authenticated",
  workspaceId: "ws-jorge",
  dbUrl: "libsql://wl-jorge.turso.io",
  token: "read-only-jorge",
  sharedByEmail: "jorge@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.target = VIEWER;
  state.workspace = null;
});

describe("pages closed to a viewer (#1843)", () => {
  test("/ajustes redirects to /app before the page shell opens", async () => {
    await expect(AjustesContent({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "redirected to /app",
    );
    expect(state.resolvePageShell).not.toHaveBeenCalled();
  });

  test("/ajustes/conexiones redirects to /app before the page shell opens", async () => {
    await expect(
      ConexionesContent({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("redirected to /app");
    expect(state.resolvePageShell).not.toHaveBeenCalled();
  });

  test("/premium/pagar redirects to /premium without creating a checkout", async () => {
    await expect(
      PagarContent({ searchParams: Promise.resolve({ tier: "premium-monthly" }) }),
    ).rejects.toThrow("redirected to /premium");
    expect(state.checkoutUrl).not.toHaveBeenCalled();
  });

  test("/bienvenida redirects to /app", async () => {
    await expect(BienvenidaPage()).rejects.toThrow("redirected to /app");
  });

  test("/empezar on an empty shared workspace shows the notice and the way out, never the form", async () => {
    const html = renderToStaticMarkup(
      await EmpezarPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain("Este espacio todavía está vacío");
    expect(html).toContain('action="/viewing/exit"');
    expect(html).not.toContain("Empezar solo");
    expect(html).not.toContain("Crear hogar");
    expect(html).not.toContain('type="file"');
  });

  test("/empezar on a shared workspace with data still goes to /app", async () => {
    state.workspace = { members: [], mode: "individual" };

    await expect(EmpezarPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "redirected to /app",
    );
  });
});
