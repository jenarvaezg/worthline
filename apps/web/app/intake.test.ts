import type { Member } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  buildSnapshotId,
  parseAssetCommand,
  parseEntityId,
  parseInvestmentAssetCommand,
  parseLiabilityCommand,
  parseMoneyMinorField,
  parseNewMember,
  parseOperationCommand,
  parseOwnership,
  parseScopeParam,
  parseSnapshotForm,
  parseViewParam,
  parseWorkspaceInit,
  resolveOwnershipSplit,
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

  test("parseViewParam returns the liquid framing only for liquid, else total", () => {
    expect(parseViewParam("liquid")).toBe("liquid");
    expect(parseViewParam("total")).toBe("total");
    expect(parseViewParam("nonsense")).toBe("total");
    expect(parseViewParam(undefined)).toBe("total");
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

describe("resolveOwnershipSplit", () => {
  const ana: Member = { id: "member_ana", name: "Ana" };
  const jose: Member = { id: "member_jose", name: "Jose" };
  const lia: Member = { id: "member_lia", name: "Lia" };
  const total = (shares: { shareBps: number }[]) =>
    shares.reduce((sum, share) => sum + share.shareBps, 0);

  test("a single active member always owns 100%", () => {
    expect(resolveOwnershipSplit({ activeMembers: [jose], preset: "even" })).toEqual([
      { memberId: "member_jose", shareBps: 10_000 },
    ]);
  });

  test("the scope preset gives 100% to the active scope member", () => {
    expect(
      resolveOwnershipSplit({
        activeMembers: [ana, jose],
        scopeMemberId: "member_jose",
        preset: "scope",
      }),
    ).toEqual([{ memberId: "member_jose", shareBps: 10_000 }]);
  });

  test("the even preset splits equally and totals 100%", () => {
    expect(resolveOwnershipSplit({ activeMembers: [ana, jose], preset: "even" })).toEqual([
      { memberId: "member_ana", shareBps: 5_000 },
      { memberId: "member_jose", shareBps: 5_000 },
    ]);
  });

  test("an even split of three distributes the remainder to total exactly 100%", () => {
    const split = resolveOwnershipSplit({ activeMembers: [ana, jose, lia], preset: "even" });
    expect(total(split)).toBe(10_000);
    expect(split.map((share) => share.shareBps)).toEqual([3_334, 3_333, 3_333]);
  });

  test("the custom preset keeps shares that already total 100%", () => {
    expect(
      resolveOwnershipSplit({
        activeMembers: [ana, jose],
        preset: "custom",
        customBps: { member_ana: 3_000, member_jose: 7_000 },
      }),
    ).toEqual([
      { memberId: "member_ana", shareBps: 3_000 },
      { memberId: "member_jose", shareBps: 7_000 },
    ]);
  });

  test("the custom preset auto-completes the remainder for unset members", () => {
    const split = resolveOwnershipSplit({
      activeMembers: [ana, jose],
      preset: "custom",
      customBps: { member_ana: 3_000 },
    });
    expect(total(split)).toBe(10_000);
    expect(split.find((share) => share.memberId === "member_jose")?.shareBps).toBe(7_000);
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

describe("investment intake", () => {
  test("parseInvestmentAssetCommand builds a market-tier asset with optional symbol and price", () => {
    const command = parseInvestmentAssetCommand(
      form({
        manualPricePerUnit: "12,50",
        name: "ACME",
        owner_member_ana: "100",
        unitSymbol: "acme",
      }),
      members,
      3,
    );

    expect(command).toMatchObject({
      currency: "EUR",
      liquidityTier: "market",
      manualPricePerUnit: "12.50",
      name: "ACME",
      unitSymbol: "acme",
    });
    expect(command.id).toBe("asset_acme_3");
    expect(command.ownership).toEqual([{ memberId: "member_ana", shareBps: 10_000 }]);
  });

  test("parseInvestmentAssetCommand omits price and symbol when blank", () => {
    const command = parseInvestmentAssetCommand(form({ name: "ACME" }), members, 1);

    expect(command.manualPricePerUnit).toBeUndefined();
    expect(command.unitSymbol).toBeUndefined();
  });

  test("parseOperationCommand normalizes units and price to canonical decimal strings", () => {
    const command = parseOperationCommand(
      form({
        assetId: "asset_acme",
        executedAt: "2026-03-01",
        fees: "9,99",
        kind: "sell",
        pricePerUnit: "1.234,56",
        units: "0,5",
      }),
      7,
      "2026-06-08",
    );

    expect(command).toMatchObject({
      assetId: "asset_acme",
      currency: "EUR",
      executedAt: "2026-03-01",
      feesMinor: 999,
      kind: "sell",
      pricePerUnit: "1234.56",
      units: "0.5",
    });
  });

  test("parseOperationCommand defaults the date to today and the kind to buy", () => {
    const command = parseOperationCommand(
      form({ assetId: "asset_acme", pricePerUnit: "100", units: "1" }),
      2,
      "2026-06-08",
    );

    expect(command.executedAt).toBe("2026-06-08");
    expect(command.kind).toBe("buy");
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

  test("parseMoneyMinorField returns null for invalid input", () => {
    expect(parseMoneyMinorField(form({ amount: "abc" }), "amount")).toBeNull();
    expect(parseMoneyMinorField(form({}), "amount")).toBeNull();
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
