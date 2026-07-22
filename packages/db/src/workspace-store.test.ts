/**
 * Member profile round-trip (PRD #421, #423): birth_year, fiscal_country and
 * risk_tolerance persist through create / update / read against a real SQLite
 * database migrated to the current schema version.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Member } from "@worthline/domain";
import { parseWorkspaceExport } from "@worthline/domain";
import { describe, expect, it } from "vitest";

import { createWorthlineStoreUnsafe } from "./unsafe-store";

async function freshStore(): Promise<
  Awaited<ReturnType<typeof createWorthlineStoreUnsafe>>
> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "wl-member-")), "w.sqlite");
  const store = await createWorthlineStoreUnsafe({ databasePath: dbPath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "m1", name: "Uno" }],
    mode: "household",
  });
  return store;
}

function memberById(members: Member[], id: string): Member {
  return members.find((m) => m.id === id)!;
}

describe("member profile persistence", () => {
  it("round-trips a profile set at member creation", async () => {
    const store = await freshStore();
    await store.workspace.createMember({
      id: "m2",
      name: "Dos",
      birthYear: 1992,
      fiscalCountry: "PT",
      riskTolerance: "aggressive",
    });

    const workspace = await store.workspace.readWorkspace();
    expect(memberById(workspace!.members, "m2")).toMatchObject({
      id: "m2",
      name: "Dos",
      birthYear: 1992,
      fiscalCountry: "PT",
      riskTolerance: "aggressive",
    });
  });

  it("updateMemberProfile overwrites the profile fields", async () => {
    const store = await freshStore();
    await store.workspace.updateMemberProfile("m1", {
      birthYear: 1990,
      fiscalCountry: "ES",
      riskTolerance: "moderate",
    });

    const workspace = await store.workspace.readWorkspace();
    expect(memberById(workspace!.members, "m1")).toMatchObject({
      birthYear: 1990,
      fiscalCountry: "ES",
      riskTolerance: "moderate",
    });
  });

  it("clears profile fields when updated with undefined", async () => {
    const store = await freshStore();
    await store.workspace.updateMemberProfile("m1", {
      birthYear: 1990,
      fiscalCountry: "ES",
      riskTolerance: "moderate",
    });
    await store.workspace.updateMemberProfile("m1", {});

    const member = memberById((await store.workspace.readWorkspace())!.members, "m1");
    expect(member.birthYear).toBeUndefined();
    expect(member.fiscalCountry).toBeUndefined();
    expect(member.riskTolerance).toBeUndefined();
  });

  it("leaves the profile unset for a member created without one", async () => {
    const store = await freshStore();
    const member = memberById((await store.workspace.readWorkspace())!.members, "m1");
    expect(member.birthYear).toBeUndefined();
    expect(member.fiscalCountry).toBeUndefined();
    expect(member.riskTolerance).toBeUndefined();
  });

  it("survives an export → parse → import round-trip", async () => {
    const source = await freshStore();
    await source.workspace.updateMemberProfile("m1", {
      birthYear: 1988,
      fiscalCountry: "ES",
      riskTolerance: "conservative",
    });

    // Exercise the real path: serialize → parseWorkspaceExport (Zod) → import.
    const doc = await source.workspace.exportWorkspace();
    const parsed = parseWorkspaceExport(JSON.parse(JSON.stringify(doc)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));

    const target = await freshStore();
    await target.workspace.importWorkspace(parsed.value);

    expect(
      memberById((await target.workspace.readWorkspace())!.members, "m1"),
    ).toMatchObject({
      birthYear: 1988,
      fiscalCountry: "ES",
      riskTolerance: "conservative",
    });
  });
});
