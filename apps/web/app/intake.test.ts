import type { Member } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  buildSnapshotId,
  parseAssetCommand,
  parseEntityId,
  parseLiabilityCommand,
  parseMoneyMinorField,
  parseNewMember,
  parseOwnership,
  parseScopeParam,
  parseSnapshotForm,
  parseViewParam,
  parseWorkspaceInit,
  validateOwnershipShares,
} from "./intake";

const members: Member[] = [
  { id: "member_ana", name: "Ana" },
  { id: "member_jose", name: "Jose" },
];

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
}

describe("scope and view params", () => {
  test("parseScopeParam normalizes arrays and defaults to household", () => {
    expect(parseScopeParam("member_jose")).toBe("member_jose");
    expect(parseScopeParam(["member_ana", "member_jose"])).toBe("member_ana");
    expect(parseScopeParam(undefined)).toBe("household");
  });

  test("parseViewParam accepts known modes and falls back to liquid", () => {
    expect(parseViewParam("gross-debt")).toBe("gross-debt");
    expect(parseViewParam("housing-inclusive")).toBe("housing-inclusive");
    expect(parseViewParam("nonsense")).toBe("liquid");
    expect(parseViewParam(undefined)).toBe("liquid");
  });
});

describe("workspace init", () => {
  test("individual mode keeps only the first member", () => {
    const command = parseWorkspaceInit(form({ mode: "individual", memberNames: "Ana\nJose" }));
    expect(command.mode).toBe("individual");
    expect(command.members.map((member) => member.name)).toEqual(["Ana"]);
  });

  test("household mode splits names on newlines and commas with stable ids", () => {
    const command = parseWorkspaceInit(
      form({ mode: "household", memberNames: "Ana, Jose\nLuz" }),
    );
    expect(command.mode).toBe("household");
    expect(command.members.map((member) => member.name)).toEqual(["Ana", "Jose", "Luz"]);
    // Ids are deterministic from name + position, so a re-parse matches.
    expect(parseWorkspaceInit(form({ mode: "household", memberNames: "Ana, Jose\nLuz" }))).toEqual(
      command,
    );
  });

  test("empty member names default to a single member", () => {
    const command = parseWorkspaceInit(form({ mode: "household", memberNames: "" }));
    expect(command.members).toHaveLength(1);
  });
});

describe("ownership parsing", () => {
  test("converts percentages to basis points", () => {
    const ownership = parseOwnership(form({ owner_member_ana: "25", owner_member_jose: "75" }), members);
    expect(ownership).toEqual([
      { memberId: "member_ana", shareBps: 2_500 },
      { memberId: "member_jose", shareBps: 7_500 },
    ]);
  });

  test("falls back to a single full owner when nothing positive is entered", () => {
    const ownership = parseOwnership(form({}), members);
    expect(ownership).toEqual([{ memberId: "member_ana", shareBps: 10_000 }]);
  });
});

describe("ownership validation", () => {
  test("accepts shares that add up to 100%", () => {
    expect(
      validateOwnershipShares([
        { memberId: "member_ana", shareBps: 2_500 },
        { memberId: "member_jose", shareBps: 7_500 },
      ]),
    ).toBeNull();
    expect(validateOwnershipShares([{ memberId: "member_ana", shareBps: 10_000 }])).toBeNull();
  });

  test("rejects shares that do not add up to 100% with a user-facing message", () => {
    const error = validateOwnershipShares([
      { memberId: "member_ana", shareBps: 6_000 },
      { memberId: "member_jose", shareBps: 3_000 },
    ]);
    expect(error).toContain("100%");
  });

  test("rejects shares that exceed 100%", () => {
    expect(
      validateOwnershipShares([
        { memberId: "member_ana", shareBps: 10_000 },
        { memberId: "member_jose", shareBps: 5_000 },
      ]),
    ).toContain("100%");
  });
});

describe("asset and liability commands", () => {
  test("parseAssetCommand builds a validated asset input with a seeded id", () => {
    const command = parseAssetCommand(
      form({
        name: "Caja",
        type: "cash",
        currentValue: "1.234,56",
        liquidityTier: "cash",
        isPrimaryResidence: "on",
        owner_member_ana: "100",
      }),
      members,
      42,
    );
    expect(command).toMatchObject({
      currency: "EUR",
      currentValueMinor: 123_456,
      isPrimaryResidence: true,
      liquidityTier: "cash",
      name: "Caja",
      type: "cash",
    });
    expect(command.id).toBe("asset_caja_42");
    expect(command.ownership).toEqual([{ memberId: "member_ana", shareBps: 10_000 }]);
  });

  test("parseAssetCommand coerces unknown type and tier to safe defaults", () => {
    const command = parseAssetCommand(
      form({ name: "X", type: "bogus", currentValue: "0", liquidityTier: "bogus" }),
      members,
      1,
    );
    expect(command.type).toBe("cash");
    expect(command.liquidityTier).toBe("cash");
  });

  test("parseLiabilityCommand carries type and optional associated asset", () => {
    const command = parseLiabilityCommand(
      form({
        name: "Hipoteca",
        type: "mortgage",
        balance: "180.000,00",
        associatedAssetId: "asset_home",
        owner_member_jose: "100",
      }),
      members,
      7,
    );
    expect(command).toMatchObject({
      associatedAssetId: "asset_home",
      balanceMinor: 18_000_000,
      currency: "EUR",
      name: "Hipoteca",
      type: "mortgage",
    });
    expect(command.id).toBe("debt_hipoteca_7");
  });

  test("parseLiabilityCommand omits an empty associated asset", () => {
    const command = parseLiabilityCommand(
      form({ name: "Tarjeta", type: "debt", balance: "100", associatedAssetId: "" }),
      members,
      9,
    );
    expect(command.associatedAssetId).toBeUndefined();
    expect(command.type).toBe("debt");
  });
});

describe("snapshot, money field, and id parsing", () => {
  test("parseSnapshotForm reads scope and checkboxes", () => {
    expect(
      parseSnapshotForm(form({ scopeId: "member_ana", isMonthlyClose: "on" })),
    ).toEqual({ isMonthlyClose: true, replace: false, scopeId: "member_ana" });
  });

  test("parseMoneyMinorField parses a localized amount to minor units", () => {
    expect(parseMoneyMinorField(form({ amount: "1.234,56" }), "amount")).toBe(123_456);
  });

  test("parseEntityId returns null when missing", () => {
    expect(parseEntityId(form({ id: "asset_x" }))).toBe("asset_x");
    expect(parseEntityId(form({}))).toBeNull();
  });

  test("parseNewMember trims and returns null for blank names", () => {
    expect(parseNewMember(form({ name: "  Noa  " }), 5)).toEqual({
      id: "member_noa_5",
      name: "Noa",
    });
    expect(parseNewMember(form({ name: "   " }), 5)).toBeNull();
  });

  test("buildSnapshotId is deterministic from scope and capture date", () => {
    expect(buildSnapshotId("household", "2026-06-08T21:00:00.000Z", 3)).toBe(
      "snapshot_household_2026_06_08_3",
    );
  });
});
