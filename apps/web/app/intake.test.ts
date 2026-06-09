import type { Member } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  appendParam,
  buildCurrentUrl,
  buildCurrentUrlFor,
  buildSnapshotId,
  errorRedirectUrl,
  okMessage,
  parseFormError,
  parseScopeCookie,
  preserveFields,
  pricesRefreshedRedirectUrl,
  resolveOkMessage,
  parseAssetCommand,
  parseAssetCommandStrict,
  parseEntityId,
  parseFireConfigFormStrict,
  parseInvestmentAssetCommand,
  parseInvestmentAssetCommandStrict,
  parseLiabilityCommand,
  parseMoneyMinorField,
  parseNewMember,
  parseOperationCommand,
  parseOwnership,
  parseRouteOperationCommand,
  parseScopeParam,
  parseSnapshotForm,
  parseUpdateInvestmentCommand,
  parseValueUpdatePass,
  parseViewParam,
  parseWorkspaceInit,
  resolveOwnershipSplit,
  successRedirectUrl,
  validateOwnershipShares,
  validateOwnershipSharesStrict,
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

describe("parseScopeCookie", () => {
  test("returns the cookie value trimmed", () => {
    expect(parseScopeCookie("member_jose")).toBe("member_jose");
    expect(parseScopeCookie("  household  ")).toBe("household");
  });

  test("returns undefined for blank or missing values", () => {
    expect(parseScopeCookie(undefined)).toBeUndefined();
    expect(parseScopeCookie("")).toBeUndefined();
    expect(parseScopeCookie("   ")).toBeUndefined();
  });
});

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
    const command = parseWorkspaceInit(
      form({ mode: "individual", memberNames: "Ana\nJose" }),
    );
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
    expect(
      parseWorkspaceInit(form({ mode: "household", memberNames: "Ana, Jose\nLuz" })),
    ).toEqual(command);
  });

  test("empty member names default to a single member", () => {
    const command = parseWorkspaceInit(form({ mode: "household", memberNames: "" }));
    expect(command.members).toHaveLength(1);
  });
});

describe("ownership parsing", () => {
  test("converts percentages to basis points", () => {
    const ownership = parseOwnership(
      form({ owner_member_ana: "25", owner_member_jose: "75" }),
      members,
    );
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
    expect(resolveOwnershipSplit({ activeMembers: [ana, jose], preset: "even" })).toEqual(
      [
        { memberId: "member_ana", shareBps: 5_000 },
        { memberId: "member_jose", shareBps: 5_000 },
      ],
    );
  });

  test("an even split of three distributes the remainder to total exactly 100%", () => {
    const split = resolveOwnershipSplit({
      activeMembers: [ana, jose, lia],
      preset: "even",
    });
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
    expect(
      validateOwnershipShares([{ memberId: "member_ana", shareBps: 10_000 }]),
    ).toBeNull();
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

describe("appendParam", () => {
  test("adds a param to a bare path", () => {
    expect(appendParam("/", "ok", "saved")).toBe("/?ok=saved");
  });

  test("appends to an existing query string", () => {
    expect(appendParam("/?scope=household&view=total", "ok", "saved")).toBe(
      "/?scope=household&view=total&ok=saved",
    );
  });

  test("replaces an existing value for the same key", () => {
    expect(appendParam("/?ok=old", "ok", "new")).toBe("/?ok=new");
  });

  test("url-encodes the value", () => {
    expect(appendParam("/", "error", "Valor inválido")).toBe(
      "/?error=Valor+inv%C3%A1lido",
    );
  });
});

describe("okMessage", () => {
  test("maps a known key to a localized message", () => {
    expect(okMessage("saved")).toBe("Guardado.");
    expect(okMessage("snapshot_saved")).toBe("Snapshot guardado.");
  });

  test("returns null for unknown or missing keys", () => {
    expect(okMessage("nonsense")).toBeNull();
    expect(okMessage(undefined)).toBeNull();
  });
});

/** Decode a redirect URL's query into the searchParams record Next.js hands the page. */
function searchParamsOf(url: string): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};

  for (const [key, value] of new URLSearchParams(url.split("?")[1] ?? "")) {
    const existing = params[key];
    params[key] = existing
      ? [...(Array.isArray(existing) ? existing : [existing]), value]
      : value;
  }

  return params;
}

describe("buildCurrentUrl", () => {
  test("keeps navigation params like scope, view and fireEdit", () => {
    expect(
      buildCurrentUrl({ scope: "member_ana", view: "liquid", fireEdit: "true" }),
    ).toBe("/?scope=member_ana&view=liquid&fireEdit=true");
  });

  test("strips one-shot feedback params so banners never persist", () => {
    expect(
      buildCurrentUrl({
        error: "Valor inválido",
        failed: "ACME",
        form: "asset",
        ok: "saved",
        scope: "household",
        updated: "2",
        v_currentValue: "abc",
        v_name: "Caja",
      }),
    ).toBe("/?scope=household");
  });

  test("returns the root when nothing survives stripping", () => {
    expect(buildCurrentUrl({ ok: "saved", v_name: "x" })).toBe("/");
    expect(buildCurrentUrl(undefined)).toBe("/");
  });
});

describe("error redirect round-trip", () => {
  test("errorRedirectUrl carries message, form id and typed values", () => {
    const url = errorRedirectUrl("/?scope=household", {
      formId: "asset",
      message: "El valor del activo no es válido.",
      values: { currentValue: "12,3,4", name: "Caja fuerte" },
    });
    const params = searchParamsOf(url);

    expect(params["error"]).toBe("El valor del activo no es válido.");
    expect(params["form"]).toBe("asset");
    expect(params["v_currentValue"]).toBe("12,3,4");
    expect(params["v_name"]).toBe("Caja fuerte");
    expect(params["scope"]).toBe("household");
  });

  test("parseFormError reconstructs the failing form and its typed values", () => {
    const url = errorRedirectUrl("/?scope=household", {
      formId: "liability",
      message: "El saldo de la deuda no es válido.",
      values: { balance: "no-num", name: "Hipoteca" },
    });
    const context = parseFormError(searchParamsOf(url));

    expect(context).toEqual({
      formId: "liability",
      message: "El saldo de la deuda no es válido.",
      values: { balance: "no-num", name: "Hipoteca" },
    });
  });

  test("parseFormError handles errors without form context", () => {
    expect(parseFormError({ error: "Algo falló" })).toEqual({
      formId: null,
      message: "Algo falló",
      values: {},
    });
    expect(parseFormError({ scope: "household" })).toBeNull();
    expect(parseFormError(undefined)).toBeNull();
  });
});

describe("preserveFields", () => {
  test("keeps listed fields and prefixed fields, ignoring the rest", () => {
    const values = preserveFields(
      form({
        currentUrl: "/?scope=household",
        currentValue: "abc",
        name: "Caja",
        owner_member_ana: "60",
        owner_member_jose: "40",
        ownershipPreset: "custom",
      }),
      ["name", "currentValue", "ownershipPreset"],
      ["owner_"],
    );

    expect(values).toEqual({
      currentValue: "abc",
      name: "Caja",
      owner_member_ana: "60",
      owner_member_jose: "40",
      ownershipPreset: "custom",
    });
  });
});

describe("prices refresh feedback", () => {
  test("pricesRefreshedRedirectUrl encodes the outcome", () => {
    const url = pricesRefreshedRedirectUrl("/?scope=household", {
      failedSymbols: ["ACME", "FOO"],
      updated: 2,
    });
    const params = searchParamsOf(url);

    expect(params["ok"]).toBe("prices_refreshed");
    expect(params["updated"]).toBe("2");
    expect(params["failed"]).toBe("ACME,FOO");
  });

  test("resolveOkMessage reports the updated count and which symbols failed", () => {
    const url = pricesRefreshedRedirectUrl("/", { failedSymbols: ["ACME"], updated: 2 });

    expect(resolveOkMessage(searchParamsOf(url))).toBe(
      "Precios actualizados: 2. Con error: ACME.",
    );
    expect(
      resolveOkMessage(
        searchParamsOf(
          pricesRefreshedRedirectUrl("/", { failedSymbols: [], updated: 3 }),
        ),
      ),
    ).toBe("Precios actualizados: 3.");
  });

  test("resolveOkMessage explains when there was nothing to refresh", () => {
    expect(
      resolveOkMessage(
        searchParamsOf(
          pricesRefreshedRedirectUrl("/", { failedSymbols: [], updated: 0 }),
        ),
      ),
    ).toBe("Sin inversiones con símbolo que actualizar.");
  });

  test("resolveOkMessage falls back to the static ok map", () => {
    expect(resolveOkMessage({ ok: "saved" })).toBe("Guardado.");
    expect(resolveOkMessage({ ok: "prices_refreshed" })).toBe("Precios actualizados.");
    expect(resolveOkMessage({})).toBeNull();
    expect(resolveOkMessage(undefined)).toBeNull();
  });
});

// ─── Issue #54: intake v2 ────────────────────────────────────────────────────

describe("validateOwnershipSharesStrict — specific sum in error message", () => {
  test("returns null when shares total exactly 10000 bps", () => {
    expect(
      validateOwnershipSharesStrict([
        { memberId: "member_ana", shareBps: 2_500 },
        { memberId: "member_jose", shareBps: 7_500 },
      ]),
    ).toBeNull();
  });

  test("rejects 99.9% (9990 bps) and names the actual sum", () => {
    const error = validateOwnershipSharesStrict([
      { memberId: "member_ana", shareBps: 4_995 },
      { memberId: "member_jose", shareBps: 4_995 },
    ]);
    expect(error).toContain("99.9");
    expect(error).toContain("100%");
  });

  test("rejects 100.1% (10010 bps) and names the actual sum", () => {
    const error = validateOwnershipSharesStrict([
      { memberId: "member_ana", shareBps: 5_005 },
      { memberId: "member_jose", shareBps: 5_005 },
    ]);
    expect(error).toContain("100.1");
    expect(error).toContain("100%");
  });

  test("rejects 110% and names the actual sum in the message", () => {
    const error = validateOwnershipSharesStrict([
      { memberId: "member_ana", shareBps: 5_500 },
      { memberId: "member_jose", shareBps: 5_500 },
    ]);
    // Message must contain the actual sum percentage
    expect(error).toContain("110");
    expect(error).toContain("100%");
  });

  test("accepts exactly 100% (10000 bps) for a single member", () => {
    expect(
      validateOwnershipSharesStrict([{ memberId: "member_ana", shareBps: 10_000 }]),
    ).toBeNull();
  });
});

describe("parseAssetCommandStrict — required name, no ghost defaults", () => {
  test("returns the parsed command when name is provided", () => {
    const result = parseAssetCommandStrict(
      form({ name: "Casa", type: "real_estate", currentValue: "200000", liquidityTier: "housing" }),
      members,
      1,
    );
    expect(result).toEqual({ ok: true, command: expect.objectContaining({ name: "Casa" }) });
  });

  test("returns an error when name is blank", () => {
    const result = parseAssetCommandStrict(
      form({ name: "   ", type: "cash", currentValue: "100", liquidityTier: "cash" }),
      members,
      1,
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toBeTruthy();
  });

  test("returns an error when name is missing", () => {
    const result = parseAssetCommandStrict(
      form({ type: "cash", currentValue: "100", liquidityTier: "cash" }),
      members,
      1,
    );
    expect(result.ok).toBe(false);
  });
});

describe("parseValueUpdatePass — value-update-pass diffing", () => {
  test("returns update commands only for changed values", () => {
    const commands = parseValueUpdatePass(
      form({ "val_asset_a": "1500", "val_asset_b": "2000" }),
      [
        { id: "asset_a", currentValueMinor: 150_000 },
        { id: "asset_b", currentValueMinor: 200_000 },
      ],
    );
    // Neither changed (1500 EUR = 150000 minor, 2000 EUR = 200000 minor)
    expect(commands).toHaveLength(0);
  });

  test("emits an update command for each value that changed", () => {
    const commands = parseValueUpdatePass(
      form({ "val_asset_a": "1600", "val_asset_b": "2000" }),
      [
        { id: "asset_a", currentValueMinor: 150_000 },
        { id: "asset_b", currentValueMinor: 200_000 },
      ],
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ id: "asset_a", newValueMinor: 160_000 });
  });

  test("reports a parse error for rows where the value is invalid", () => {
    const commands = parseValueUpdatePass(
      form({ "val_asset_a": "not-a-number", "val_asset_b": "2000" }),
      [
        { id: "asset_a", currentValueMinor: 150_000 },
        { id: "asset_b", currentValueMinor: 200_000 },
      ],
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ id: "asset_a", error: expect.any(String) });
  });

  test("emits update commands for all changed values across multiple rows", () => {
    const commands = parseValueUpdatePass(
      form({ "val_asset_a": "1600", "val_asset_b": "2500" }),
      [
        { id: "asset_a", currentValueMinor: 150_000 },
        { id: "asset_b", currentValueMinor: 200_000 },
      ],
    );
    expect(commands).toHaveLength(2);
    expect(commands.find((c) => c.id === "asset_a")).toEqual({ id: "asset_a", newValueMinor: 160_000 });
    expect(commands.find((c) => c.id === "asset_b")).toEqual({ id: "asset_b", newValueMinor: 250_000 });
  });
});

describe("okMessage — specific catalog keys for intake v2", () => {
  test("asset_added carries the holding name", () => {
    // The catalog key for a named asset add
    expect(okMessage("asset_added")).not.toBeNull();
  });

  test("deleted_recoverable maps to a trash message", () => {
    expect(okMessage("deleted_recoverable")).not.toBeNull();
    expect(okMessage("deleted_recoverable")).toContain("Papelera");
  });

  test("restored maps to a restoration message", () => {
    expect(okMessage("restored")).not.toBeNull();
  });

  test("liability_added is present", () => {
    expect(okMessage("liability_added")).not.toBeNull();
  });

  test("investment_added is present", () => {
    expect(okMessage("investment_added")).not.toBeNull();
  });
});

describe("successRedirectUrl — anchor-carrying redirects", () => {
  test("appends an anchor fragment to the ok redirect url", () => {
    const url = successRedirectUrl("/?scope=household", "asset_added", "asset_abc123");
    // The URL must carry the ok key
    expect(url).toContain("ok=asset_added");
    // And must carry the anchor
    expect(url).toContain("#asset_abc123");
  });

  test("works without an anchor (anchor is optional)", () => {
    const url = successRedirectUrl("/?scope=household", "saved");
    expect(url).toContain("ok=saved");
    expect(url).not.toContain("#");
  });

  test("anchor from errorRedirectUrl is also carried", () => {
    const url = errorRedirectUrl("/?scope=household", {
      message: "Error de prueba",
      formId: "asset",
      values: {},
      anchor: "asset_abc123",
    });
    expect(url).toContain("#asset_abc123");
  });
});

describe("parseFireConfigFormStrict — rejects garbage FIRE input", () => {
  test("returns ok with config for valid inputs", () => {
    const result = parseFireConfigFormStrict(
      form({ monthlySpending: "2000", safeWithdrawalRate: "4", expectedRealReturn: "7" }),
    );
    expect(result.ok).toBe(true);
  });

  test("rejects zero monthly spending", () => {
    const result = parseFireConfigFormStrict(
      form({ monthlySpending: "0", safeWithdrawalRate: "4", expectedRealReturn: "7" }),
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toBeTruthy();
  });

  test("rejects negative monthly spending", () => {
    const result = parseFireConfigFormStrict(
      form({ monthlySpending: "-100", safeWithdrawalRate: "4", expectedRealReturn: "7" }),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects zero safe withdrawal rate", () => {
    const result = parseFireConfigFormStrict(
      form({ monthlySpending: "2000", safeWithdrawalRate: "0", expectedRealReturn: "7" }),
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toBeTruthy();
  });

  test("rejects zero expected real return", () => {
    const result = parseFireConfigFormStrict(
      form({ monthlySpending: "2000", safeWithdrawalRate: "4", expectedRealReturn: "0" }),
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toBeTruthy();
  });

  test("rejects non-numeric garbage in spending field", () => {
    const result = parseFireConfigFormStrict(
      form({ monthlySpending: "abc", safeWithdrawalRate: "4", expectedRealReturn: "7" }),
    );
    expect(result.ok).toBe(false);
  });
});

// === #58 inversiones ===

describe("buildCurrentUrlFor — subpage-scoped return URL", () => {
  test("returns the basePath bare when no persistent params exist", () => {
    expect(buildCurrentUrlFor("/inversiones")).toBe("/inversiones");
    expect(buildCurrentUrlFor("/inversiones", { ok: "saved", v_name: "x" })).toBe(
      "/inversiones",
    );
  });

  test("preserves non-one-shot params under the given base path", () => {
    expect(buildCurrentUrlFor("/inversiones", { scope: "member_jose" })).toBe(
      "/inversiones?scope=member_jose",
    );
  });

  test("strips one-shot feedback params just like buildCurrentUrl does", () => {
    expect(
      buildCurrentUrlFor("/inversiones/nueva", {
        error: "bad",
        form: "investment",
        ok: "saved",
        scope: "household",
      }),
    ).toBe("/inversiones/nueva?scope=household");
  });
});

describe("parseInvestmentAssetCommandStrict — required name, strict price", () => {
  test("returns ok command for valid inputs", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({ name: "ACME ETF", unitSymbol: "acme.us", manualPricePerUnit: "12,50" }),
      members,
      42,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.name).toBe("ACME ETF");
    expect(result.command.manualPricePerUnit).toBe("12.50");
    expect(result.command.unitSymbol).toBe("acme.us");
    expect(result.command.liquidityTier).toBe("market");
  });

  test("rejects blank name", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({ name: "   ", manualPricePerUnit: "10" }),
      members,
      1,
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("nombre");
  });

  test("rejects missing name", () => {
    const result = parseInvestmentAssetCommandStrict(form({}), members, 1);
    expect(result.ok).toBe(false);
  });

  test("rejects non-numeric manual price", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({ name: "ACME", manualPricePerUnit: "abc" }),
      members,
      1,
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("precio");
  });

  test("rejects negative manual price", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({ name: "ACME", manualPricePerUnit: "-5" }),
      members,
      1,
    );
    expect(result.ok).toBe(false);
  });

  test("accepts blank manual price (omits it from command)", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({ name: "ACME" }),
      members,
      1,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.manualPricePerUnit).toBeUndefined();
  });

  test("omits symbol and isin when blank", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({ name: "ACME", unitSymbol: "", isin: "" }),
      members,
      1,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.unitSymbol).toBeUndefined();
    expect(result.command.isin).toBeUndefined();
  });
});

describe("parseRouteOperationCommand — asset id from route, strict field errors", () => {
  test("returns ok command for valid buy", () => {
    const result = parseRouteOperationCommand(
      form({ kind: "buy", executedAt: "2026-01-15", units: "5", pricePerUnit: "100", fees: "9,99" }),
      "asset_acme",
      7,
      "2026-06-09",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.assetId).toBe("asset_acme");
    expect(result.command.kind).toBe("buy");
    expect(result.command.units).toBe("5");
    expect(result.command.pricePerUnit).toBe("100");
    expect(result.command.feesMinor).toBe(999);
    expect(result.command.executedAt).toBe("2026-01-15");
  });

  test("returns ok command for valid sell with es-ES decimal notation", () => {
    const result = parseRouteOperationCommand(
      form({ kind: "sell", units: "2,5", pricePerUnit: "1.234,56", fees: "0" }),
      "asset_acme",
      8,
      "2026-06-09",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.kind).toBe("sell");
    expect(result.command.units).toBe("2.5");
    expect(result.command.pricePerUnit).toBe("1234.56");
  });

  test("defaults date to today and kind to buy when not supplied", () => {
    const result = parseRouteOperationCommand(
      form({ units: "1", pricePerUnit: "50" }),
      "asset_acme",
      9,
      "2026-06-09",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.executedAt).toBe("2026-06-09");
    expect(result.command.kind).toBe("buy");
  });

  test("errors when units are missing", () => {
    const result = parseRouteOperationCommand(
      form({ pricePerUnit: "100" }),
      "asset_acme",
      1,
      "2026-06-09",
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("unidades");
  });

  test("errors when pricePerUnit is missing", () => {
    const result = parseRouteOperationCommand(
      form({ units: "1" }),
      "asset_acme",
      1,
      "2026-06-09",
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("precio");
  });

  test("errors when units are non-numeric garbage", () => {
    const result = parseRouteOperationCommand(
      form({ units: "abc", pricePerUnit: "100" }),
      "asset_acme",
      1,
      "2026-06-09",
    );
    expect(result.ok).toBe(false);
  });

  test("errors when fees are invalid", () => {
    const result = parseRouteOperationCommand(
      form({ units: "1", pricePerUnit: "100", fees: "abc" }),
      "asset_acme",
      1,
      "2026-06-09",
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("comisiones");
  });

  test("uses the route asset id, not a dropdown field", () => {
    const result = parseRouteOperationCommand(
      // assetId field in form is ignored — route wins
      form({ units: "1", pricePerUnit: "50", assetId: "asset_wrong" }),
      "asset_correct",
      2,
      "2026-06-09",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.assetId).toBe("asset_correct");
  });
});

describe("parseUpdateInvestmentCommand — edit investment fields", () => {
  test("returns ok command for valid update", () => {
    const result = parseUpdateInvestmentCommand(
      form({ name: "ACME Updated", unitSymbol: "acme.us", isin: "US0231351067", manualPricePerUnit: "15,00" }),
      "asset_acme",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.id).toBe("asset_acme");
    expect(result.command.name).toBe("ACME Updated");
    expect(result.command.manualPricePerUnit).toBe("15.00");
    expect(result.command.unitSymbol).toBe("acme.us");
    expect(result.command.isin).toBe("US0231351067");
  });

  test("rejects blank name", () => {
    const result = parseUpdateInvestmentCommand(
      form({ name: "  " }),
      "asset_acme",
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("nombre");
  });

  test("rejects non-numeric price", () => {
    const result = parseUpdateInvestmentCommand(
      form({ name: "ACME", manualPricePerUnit: "bad" }),
      "asset_acme",
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toContain("precio");
  });

  test("omits optional fields when blank", () => {
    const result = parseUpdateInvestmentCommand(
      form({ name: "ACME", unitSymbol: "", isin: "", manualPricePerUnit: "" }),
      "asset_acme",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.unitSymbol).toBeUndefined();
    expect(result.command.isin).toBeUndefined();
    expect(result.command.manualPricePerUnit).toBeUndefined();
  });
});
