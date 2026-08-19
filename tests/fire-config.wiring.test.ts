/**
 * Wiring suite: the FIRE config action (objetivos/fire-config-actions.ts).
 *
 * The action moved here with its form (#1450): the assumptions are edited beside
 * the figures they govern, so the save redirects back to /objetivos. Driven through
 * its real FormData interface against an isolated in-memory store.
 */

import {
  saveFireConfigAction,
  setRetirementPlanAction,
} from "@web/objetivos/fire-config-actions";
import { createInMemoryStore, type WorthlineStore } from "@worthline/db";
import { afterEach, describe, expect, test, vi } from "vitest";
import { catchRedirect, fd } from "./helpers";

vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

let store: WorthlineStore;

afterEach(() => {
  store?.close();
});

async function setupStore() {
  store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_ana", name: "Ana" }],
    mode: "individual",
  });
  return store;
}

// ============================================================= saveFireConfig

describe("saveFireConfigAction wiring", () => {
  test("happy path: saves FIRE config and redirects with fire_saved", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd(
          {
            scopeId: "household",
            monthlySpending: "2000",
            safeWithdrawalRate: "4",
            expectedRealReturn: "5",
            targetRetirementAge: "55",
          },
          "/objetivos",
        ),
        store,
      ),
    );

    expect(url).toContain("ok=fire_saved");
    const configs = await store.readFireConfig("2026-08-18");
    expect(configs["household"]).toBeDefined();
    expect(configs["household"]!.monthlySpendingMinor).toBe(200_000);
  });

  test("zero monthly spending: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd(
          {
            monthlySpending: "0",
            safeWithdrawalRate: "4",
            expectedRealReturn: "5",
          },
          "/objetivos",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    // URLSearchParams encodes spaces as "+", which decodeURIComponent keeps.
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/gasto mensual/i);
  });

  test("invalid withdrawal rate: error redirect", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd(
          {
            monthlySpending: "2000",
            safeWithdrawalRate: "0",
            expectedRealReturn: "5",
          },
          "/objetivos",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url)).toMatch(/tasa/i);
  });

  // La declaración de #1460 viaja como casilla + `hidden`, así que el wiring la
  // ejercita como la manda el navegador: dos valores con el mismo nombre.
  test("unchecking the immobilized box stores the declaration", async () => {
    await setupStore();
    const form = fd(
      {
        scopeId: "household",
        monthlySpending: "2000",
        safeWithdrawalRate: "4",
        countImmobilized: "off",
      },
      "/objetivos",
    );

    const url = await catchRedirect(() => saveFireConfigAction(form, store));

    expect(url).toContain("ok=fire_saved");
    const config = (await store.readFireConfig("2026-08-18")).household;
    expect(config!.immobilizedCountsAsFireCapital).toBe(false);
  });

  test("a checked box saves the default declaration explicitly", async () => {
    await setupStore();
    const form = fd(
      {
        scopeId: "household",
        monthlySpending: "2000",
        safeWithdrawalRate: "4",
        countImmobilized: "off",
      },
      "/objetivos",
    );
    form.append("countImmobilized", "on");

    await catchRedirect(() => saveFireConfigAction(form, store));

    const config = (await store.readFireConfig("2026-08-18")).household;
    expect(config!.immobilizedCountsAsFireCapital).toBe(true);
  });

  test("invalid scope id: error redirect and no orphan FIRE config", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      saveFireConfigAction(
        fd(
          {
            scopeId: "ghost_scope",
            monthlySpending: "2000",
            safeWithdrawalRate: "4",
            expectedRealReturn: "5",
          },
          "/objetivos",
        ),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toMatch(/scope/i);
    expect((await store.readFireConfig("2026-08-18")).ghost_scope).toBeUndefined();
  });
});

// ======================================================== setRetirementPlan

/**
 * La declaración del perfil (#1428). Es el único escritor de la config FIRE que NO
 * manda el formulario entero, así que el wiring vigila lo que eso pone en juego: que
 * lo demás sobreviva, y que la edad derivada no se congele de vuelta.
 */
describe("setRetirementPlanAction wiring", () => {
  async function saveBaseConfig() {
    await catchRedirect(() =>
      saveFireConfigAction(
        fd(
          {
            scopeId: "household",
            monthlySpending: "2000",
            safeWithdrawalRate: "3.5",
            targetRetirementAge: "67",
            monthlySavingsCapacity: "1500",
            lifeExpectancyAge: "90",
          },
          "/objetivos",
        ),
        store,
      ),
    );
  }

  test("declara el plan sin tocar el resto de los supuestos", async () => {
    await setupStore();
    await saveBaseConfig();

    const url = await catchRedirect(() =>
      setRetirementPlanAction(
        fd({ scopeId: "household", retirementPlan: "ordinary" }, "/objetivos"),
        store,
      ),
    );

    expect(url).toContain("ok=fire_saved");
    const config = (await store.readFireConfig("2026-08-18")).household;
    expect(config!.retirementPlan).toBe("ordinary");
    // Lo demás sigue en pie: este escritor toca un campo, no el formulario.
    expect(config!.monthlySpendingMinor).toBe(200_000);
    expect(config!.safeWithdrawalRate).toBeCloseTo(0.035, 10);
    expect(config!.monthlySavingsCapacityMinor).toBe(150_000);
    expect(config!.lifeExpectancyAge).toBe(90);
    expect(config!.targetRetirementAge).toBe(67);
  });

  test("un «no» también se guarda: si no, el ofrecimiento volvería en cada carga", async () => {
    await setupStore();
    await saveBaseConfig();

    await catchRedirect(() =>
      setRetirementPlanAction(
        fd({ scopeId: "household", retirementPlan: "ordinary" }, "/objetivos"),
        store,
      ),
    );
    await catchRedirect(() =>
      setRetirementPlanAction(
        fd({ scopeId: "household", retirementPlan: "early" }, "/objetivos"),
        store,
      ),
    );

    const config = (await store.readFireConfig("2026-08-18")).household;
    expect(config!.retirementPlan).toBe("early");
  });

  test("no congela la edad derivada que acaba de leer", async () => {
    // Con fecha de nacimiento, `readFireConfig` DERIVA la edad al leer (#1415): este
    // escritor lee-modifica-escribe, así que reescribirla tal cual la volvería un
    // escalar guardado — y el año que viene el usuario tendría un año menos.
    store = await createInMemoryStore();
    await store.workspace.initializeWorkspace({
      members: [{ id: "member_jorge", name: "Jorge", birthYear: 1963 }],
      mode: "individual",
    });
    await saveBaseConfig();

    await catchRedirect(() =>
      setRetirementPlanAction(
        fd({ scopeId: "household", retirementPlan: "ordinary" }, "/objetivos"),
        store,
      ),
    );

    const stored = (await store.readFireConfig("2026-08-18")).household;
    // La edad sigue derivándose (63 en 2026), no viene de un campo escrito.
    expect(stored!.currentAge).toBe(63);
    const laterYear = (await store.readFireConfig("2036-08-18")).household;
    expect(laterYear!.currentAge).toBe(73);
  });

  test("sin supuestos guardados no hay pantalla que trocar", async () => {
    await setupStore();

    const url = await catchRedirect(() =>
      setRetirementPlanAction(
        fd({ scopeId: "household", retirementPlan: "ordinary" }, "/objetivos"),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect((await store.readFireConfig("2026-08-18")).household).toBeUndefined();
  });

  test("un plan que no reconocemos no escribe nada", async () => {
    await setupStore();
    await saveBaseConfig();

    const url = await catchRedirect(() =>
      setRetirementPlanAction(
        fd({ scopeId: "household", retirementPlan: "jubilado" }, "/objetivos"),
        store,
      ),
    );

    expect(url).toContain("error=");
    expect(
      (await store.readFireConfig("2026-08-18")).household!.retirementPlan,
    ).toBeUndefined();
  });
});
