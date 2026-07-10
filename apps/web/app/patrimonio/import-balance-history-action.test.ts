/**
 * Action-level tests for importBalanceHistoryAction (ADR 0056, #696) — demo
 * write-gating and the action boundary over the batched import seam.
 */

import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard";
import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { type Clock, fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";

import { importBalanceHistoryAction } from "./actions";

let mockPersonaCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

afterEach(() => {
  mockPersonaCookie = undefined;
});

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

async function runAction(
  fd: FormData,
  store: WorthlineStore,
  clock: Clock,
): Promise<string> {
  try {
    await importBalanceHistoryAction(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

const TODAY = "2026-07-02";
const CLOCK = fixedClock(TODAY);

async function seedAmortizableMortgage(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: "mJ", name: "Jose" }],
    mode: "individual",
  });
  await store.liabilities.createLiability({
    balanceMinor: 150_000_00,
    currency: "EUR",
    id: "mortgage",
    name: "Hipoteca",
    ownership: [{ memberId: "mJ", shareBps: 10_000 }],
    type: "mortgage",
  });
  await store.liabilities.setDebtModel("mortgage", "amortizable");
  await store.createAmortizationPlanAndRipple(
    {
      annualInterestRate: "0.03",
      disbursementDate: "2026-01-15",
      firstPaymentDate: "2026-02-15",
      id: "plan1",
      initialCapitalMinor: 150_000_00,
      liabilityId: "mortgage",
      termMonths: 240,
    },
    { today: TODAY },
  );
  return store;
}

describe("importBalanceHistoryAction — batched import boundary (#696)", () => {
  test("imports accepted rows and audit-trails each re-baseline", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      form({
        currentUrl: "/patrimonio/mortgage/editar",
        id: "mortgage",
        rows: JSON.stringify([
          { balanceMinor: 145_000_00, date: "2026-04-15" },
          { balanceMinor: 140_000_00, date: "2026-06-15" },
        ]),
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("balance_history_imported");

    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(2);
    const audit = await store.readAuditLog({ entityId: "mortgage" });
    expect(
      audit.filter((entry) => entry.action === "add_balance_rebaseline"),
    ).toHaveLength(2);

    store.close();
  });

  test("re-applying the same series is a no-op at the action boundary", async () => {
    const store = await seedAmortizableMortgage();

    await runAction(
      form({
        id: "mortgage",
        rows: JSON.stringify([{ balanceMinor: 140_000_00, date: "2026-06-15" }]),
      }),
      store,
      CLOCK,
    );
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(1);

    const url = await runAction(
      form({
        id: "mortgage",
        rows: JSON.stringify([{ balanceMinor: 140_000_00, date: "2026-06-15" }]),
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("balance_history_imported");
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(1);

    store.close();
  });

  test("rejects malformed row payloads before touching the store", async () => {
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      form({
        id: "mortgage",
        rows: JSON.stringify([{ balanceMinor: "140000", date: "2026-06-15" }]),
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });

  test("demo write-guard blocks the import without touching the store", async () => {
    mockPersonaCookie = "demo";
    const store = await seedAmortizableMortgage();

    const url = await runAction(
      form({
        id: "mortgage",
        rows: JSON.stringify([{ balanceMinor: 140_000_00, date: "2026-06-15" }]),
      }),
      store,
      CLOCK,
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(await store.liabilities.readBalanceRebaselines("mortgage")).toHaveLength(0);

    store.close();
  });
});
