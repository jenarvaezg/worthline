/**
 * Action-level tests for two `ajustes` write actions that had NO coverage
 * through their interface (PRD #1112 S3 acceptance): the member-profile save
 * (birth year / fiscal country / risk tolerance, with blank-clears and
 * garbage-drops semantics) and the workspace import (valid file → dashboard +
 * scope cookie; not-a-file / invalid JSON / invalid export → error redirect).
 * They run against an in-memory store, asserting the redirect digest AND the
 * store's actual state (member profile, scope cookie).
 */

import { SCOPE_COOKIE_NAME } from "@web/intake";
import type { PersistenceTestStore as WorthlineStore } from "@worthline/db/testing";
import { createInMemoryStore } from "@worthline/db/testing";
import { type Clock, fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { confirmImportAction, updateMemberProfileAction } from "./actions";

const cookieSets: { name: string; value: string }[] = [];
const cookieDeletes: string[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string) => {
      cookieSets.push({ name, value });
    },
    delete: (name: string) => {
      cookieDeletes.push(name);
    },
  }),
}));

afterEach(() => {
  cookieSets.length = 0;
  cookieDeletes.length = 0;
});

const TODAY = "2026-07-02";
const CLOCK: Clock = fixedClock(TODAY);
const MEMBER_ID = "m1";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

function formWithFile(file: unknown): FormData {
  const fd = new FormData();
  fd.set("file", file as Blob);
  return fd;
}

async function runAction(
  action: (fd: FormData, ...args: unknown[]) => Promise<never>,
  fd: FormData,
  store: WorthlineStore,
  clock: Clock,
): Promise<string> {
  try {
    await action(fd, store, clock);
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

async function seedOneMember(): Promise<WorthlineStore> {
  const store = await createInMemoryStore();
  await store.workspace.initializeWorkspace({
    members: [{ id: MEMBER_ID, name: "Alice" }],
    mode: "individual",
  });
  return store;
}

async function readMember(store: WorthlineStore) {
  const workspace = await store.workspace.readWorkspace();
  const member = workspace?.members.find((m) => m.id === MEMBER_ID);
  if (!member) {
    throw new Error("member not found");
  }
  return member;
}

/** A minimal live-state-only export document that passes parseWorkspaceExport. */
function validExport(): unknown {
  return {
    version: 3,
    workspace: { mode: "individual", baseCurrency: "EUR" },
    members: [{ id: MEMBER_ID, name: "Alice" }],
    assets: [
      {
        id: "a1",
        name: "Cuenta",
        type: "cash",
        currency: "EUR",
        currentValue: { amountMinor: 5000, currency: "EUR" },
        liquidityTier: "cash",
        ownership: [{ memberId: MEMBER_ID, shareBps: 10000 }],
      },
    ],
  };
}

describe("updateMemberProfileAction", () => {
  test("saves birth year, fiscal country and risk tolerance", async () => {
    const store = await seedOneMember();

    const url = await runAction(
      updateMemberProfileAction,
      form({
        id: MEMBER_ID,
        birthYear: "1990",
        fiscalCountry: "ES",
        riskTolerance: "moderate",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("ok=saved");

    const member = await readMember(store);
    expect(member.birthYear).toBe(1990);
    expect(member.fiscalCountry).toBe("ES");
    expect(member.riskTolerance).toBe("moderate");

    store.close();
  });

  test("a blank field clears the previously stored value", async () => {
    const store = await seedOneMember();
    await runAction(
      updateMemberProfileAction,
      form({
        id: MEMBER_ID,
        birthYear: "1990",
        fiscalCountry: "ES",
        riskTolerance: "aggressive",
      }),
      store,
      CLOCK,
    );

    const url = await runAction(
      updateMemberProfileAction,
      form({ id: MEMBER_ID, birthYear: "", fiscalCountry: "", riskTolerance: "" }),
      store,
      CLOCK,
    );
    expect(url).toContain("ok=saved");

    const member = await readMember(store);
    expect(member.birthYear).toBeUndefined();
    expect(member.fiscalCountry).toBeUndefined();
    expect(member.riskTolerance).toBeUndefined();

    store.close();
  });

  test("garbage year / unknown risk are dropped while valid fields still save", async () => {
    const store = await seedOneMember();

    const url = await runAction(
      updateMemberProfileAction,
      form({
        id: MEMBER_ID,
        birthYear: "no-es-un-año",
        fiscalCountry: "FR",
        riskTolerance: "temerario",
      }),
      store,
      CLOCK,
    );
    expect(url).toContain("ok=saved");

    const member = await readMember(store);
    expect(member.birthYear).toBeUndefined();
    expect(member.riskTolerance).toBeUndefined();
    expect(member.fiscalCountry).toBe("FR");

    store.close();
  });

  test("a missing id reports not found without writing", async () => {
    const store = await seedOneMember();

    const url = await runAction(
      updateMemberProfileAction,
      form({ birthYear: "1990" }),
      store,
      CLOCK,
    );
    expect(url).toContain("error=");

    const member = await readMember(store);
    expect(member.birthYear).toBeUndefined();

    store.close();
  });
});

describe("confirmImportAction", () => {
  test("a valid export replaces the workspace, lands on /app and sets the scope cookie", async () => {
    const store = await seedOneMember();

    const file = new File([JSON.stringify(validExport())], "export.json", {
      type: "application/json",
    });
    const url = await runAction(confirmImportAction, formWithFile(file), store, CLOCK);
    expect(url).toContain("/app");

    expect(cookieSets).toContainEqual({ name: SCOPE_COOKIE_NAME, value: MEMBER_ID });

    // The import actually replaced the workspace with the file's contents.
    const workspace = await store.workspace.readWorkspace();
    expect(workspace?.members.map((m) => m.id)).toEqual([MEMBER_ID]);
    expect((await store.assets.readAssets()).map((a) => a.id)).toContain("a1");

    store.close();
  });

  test("no file reports the file-required error under formId import", async () => {
    const store = await seedOneMember();

    const url = await runAction(confirmImportAction, form({}), store, CLOCK);
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain(
      "Selecciona un archivo de exportación (.json) para importar.",
    );
    expect(url).toContain("form=import");

    store.close();
  });

  test("invalid JSON reports the parse error", async () => {
    const store = await seedOneMember();

    const file = new File(["not json"], "export.json", { type: "application/json" });
    const url = await runAction(confirmImportAction, formWithFile(file), store, CLOCK);
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain(
      "El archivo no contiene JSON válido y no se puede importar.",
    );

    store.close();
  });

  test("a valid-JSON but invalid export reports the import-rejected error", async () => {
    const store = await seedOneMember();

    // Valid JSON that fails parseWorkspaceExport (empty members array).
    const bad = JSON.stringify({
      version: 3,
      workspace: { mode: "individual", baseCurrency: "EUR" },
      members: [],
    });
    const file = new File([bad], "export.json", { type: "application/json" });
    const url = await runAction(confirmImportAction, formWithFile(file), store, CLOCK);
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain("No se pudo importar:");
    expect(url).toContain("form=import");

    store.close();
  });
});
