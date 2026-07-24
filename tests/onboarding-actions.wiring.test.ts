/**
 * Wiring suite: onboarding server actions (empezar/actions.ts).
 *
 * initSoloAction  – individual path
 * initHogarAction – household path
 *
 * Each action is driven through its real FormData interface against an isolated
 * in-memory store.  next/cache and next/headers are stubbed; the NEXT_REDIRECT
 * digest is parsed to the target URL.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const cookieSetMock = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({ set: cookieSetMock }),
}));

import { initHogarAction, initSoloAction } from "@web/empezar/actions";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { catchRedirect, errorMessageOf, fd } from "./helpers";

let store: WorthlineStore;

afterEach(() => {
  store?.close();
  cookieSetMock.mockClear();
});

async function freshStore(): Promise<WorthlineStore> {
  store = await createInMemoryStore();
  return store;
}

// ================================================================ initSoloAction

describe("initSoloAction wiring", () => {
  test("happy path: valid name → workspace created, cookie set, redirect to onboarding", async () => {
    const s = await freshStore();

    const url = await catchRedirect(() =>
      initSoloAction(fd({ name: "Ana" }, "/empezar?path=solo"), s),
    );

    expect(url).toBe("/bienvenida");

    const ws = (await s.workspace.readWorkspace())!;
    expect(ws.mode).toBe("individual");
    expect(ws.members).toHaveLength(1);
    expect(ws.members[0].name).toBe("Ana");

    expect(cookieSetMock).toHaveBeenCalledOnce();
    expect(cookieSetMock).toHaveBeenCalledWith(
      "wl_scope",
      ws.members[0].id,
      expect.objectContaining({ httpOnly: true, path: "/", sameSite: "lax" }),
    );
  });

  test("blank name → error redirect with Spanish message and preserved value", async () => {
    const s = await freshStore();

    const url = await catchRedirect(() =>
      initSoloAction(fd({ name: "  " }, "/empezar?path=solo"), s),
    );

    expect(url).toContain("/empezar?path=solo");
    expect(errorMessageOf(url)).toBe("El nombre es obligatorio.");
    expect(url).toContain("v_name=");

    expect(await s.workspace.readWorkspace()).toBeNull();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  test("already-initialized workspace: overwrites without error", async () => {
    const s = await freshStore();
    await s.workspace.initializeWorkspace({
      members: [{ id: "old", name: "Viejo" }],
      mode: "individual",
    });

    const url = await catchRedirect(() =>
      initSoloAction(fd({ name: "Nuevo" }, "/empezar?path=solo"), s),
    );

    expect(url).toBe("/bienvenida");

    const ws = (await s.workspace.readWorkspace())!;
    expect(ws.members).toHaveLength(1);
    expect(ws.members[0].name).toBe("Nuevo");
  });
});

// ================================================================ initHogarAction

describe("initHogarAction wiring", () => {
  test("happy path: valid memberNames → household workspace, redirect to onboarding", async () => {
    const s = await freshStore();

    const url = await catchRedirect(() =>
      initHogarAction(fd({ memberNames: "Ana\nJose\nPedro" }, "/empezar?path=hogar"), s),
    );

    expect(url).toBe("/bienvenida");

    const ws = (await s.workspace.readWorkspace())!;
    expect(ws.mode).toBe("household");
    expect(ws.members).toHaveLength(3);
    expect(ws.members.map((m) => m.name)).toEqual(["Ana", "Jose", "Pedro"]);

    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  test("empty memberNames → error redirect with Spanish message", async () => {
    const s = await freshStore();

    const url = await catchRedirect(() =>
      initHogarAction(fd({ memberNames: "" }, "/empezar?path=hogar"), s),
    );

    expect(url).toContain("/empezar?path=hogar");
    expect(errorMessageOf(url)).toBe("Añade al menos un nombre.");
    expect(url).toContain("v_memberNames=");

    expect(await s.workspace.readWorkspace()).toBeNull();
  });

  test("blank lines only → error redirect", async () => {
    const s = await freshStore();

    const url = await catchRedirect(() =>
      initHogarAction(fd({ memberNames: "\n\n  \n" }, "/empezar?path=hogar"), s),
    );

    expect(errorMessageOf(url)).toBe("Añade al menos un nombre.");
    expect(await s.workspace.readWorkspace()).toBeNull();
  });

  test("already-initialized workspace: overwrites without error", async () => {
    const s = await freshStore();
    await s.workspace.initializeWorkspace({
      members: [{ id: "old", name: "Viejo" }],
      mode: "individual",
    });

    const url = await catchRedirect(() =>
      initHogarAction(fd({ memberNames: "Ana\nJose" }, "/empezar?path=hogar"), s),
    );

    expect(url).toBe("/bienvenida");

    const ws = (await s.workspace.readWorkspace())!;
    expect(ws.mode).toBe("household");
    expect(ws.members).toHaveLength(2);
    expect(ws.members.map((m) => m.name)).toEqual(["Ana", "Jose"]);
  });
});
