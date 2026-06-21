import { checkOwnershipSplit, type Member, type Workspace } from "@worthline/domain";
import { describe, expect, test } from "vitest";

import {
  appendParam,
  buildCurrentUrl,
  buildCurrentUrlFor,
  errorRedirectUrl,
  okMessage,
  parseFormError,
  parsePrivacyCookie,
  parseScopeCookie,
  preserveFields,
  pricesRefreshedRedirectUrl,
  resolveOkMessage,
  parseAssetCommandStrict,
  parseEntityId,
  parseFireConfigFormStrict,
  parseInvestmentAssetCommandStrict,
  parseLiabilityCommand,
  parseMoneyMinorField,
  parseNewMember,
  parseOwnership,
  parseRouteOperationCommand,
  parseScopeParam,
  parseUpdateInvestmentCommand,
  parseDrillParam,
  parseRangeParam,
  parseGroupParam,
  parseValuationAnchorStrict,
  parseAppreciationRateStrict,
  parseDebtModelStrict,
  parseAmortizationPlanStrict,
  parseInterestRateRevisionStrict,
  parseBalanceAnchorStrict,
  parseValueUpdatePass,
  parseViewParam,
  parseWorkspaceInit,
  mapDomainViolation,
  resolveOwnershipSplit,
  successRedirectUrl,
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

describe("parsePrivacyCookie", () => {
  test("returns true only for the exact value '1'", () => {
    expect(parsePrivacyCookie("1")).toBe(true);
    expect(parsePrivacyCookie("true")).toBe(false);
    expect(parsePrivacyCookie("yes")).toBe(false);
  });

  test("returns false for blank or missing values", () => {
    expect(parsePrivacyCookie(undefined)).toBe(false);
    expect(parsePrivacyCookie("")).toBe(false);
    expect(parsePrivacyCookie("   ")).toBe(false);
  });
});

describe("scope and view params", () => {
  test("parseScopeParam returns a trimmed explicit scope override", () => {
    expect(parseScopeParam("member_jose")).toBe("member_jose");
    expect(parseScopeParam("  household  ")).toBe("household");
    expect(parseScopeParam(["member_ana", "member_jose"])).toBe("member_ana");
    expect(parseScopeParam("")).toBeUndefined();
    expect(parseScopeParam(undefined)).toBeUndefined();
  });

  test("parseViewParam returns the liquid framing only for liquid, else total", () => {
    expect(parseViewParam("liquid")).toBe("liquid");
    expect(parseViewParam("total")).toBe("total");
    expect(parseViewParam("nonsense")).toBe("total");
    expect(parseViewParam(undefined)).toBe("total");
  });

  test("parseDrillParam accepts only known drill keys, else no drill", () => {
    expect(parseDrillParam("liquid")).toBe("liquid");
    expect(parseDrillParam("rest")).toBe("rest");
    expect(parseDrillParam("housing")).toBe("housing");
    expect(parseDrillParam("debts")).toBe("debts");
    expect(parseDrillParam(["liquid", "other"])).toBe("liquid");
    expect(parseDrillParam("nonsense")).toBeNull();
    expect(parseDrillParam(undefined)).toBeNull();
  });

  test("parseRangeParam accepts known temporal ranges, else 'all'", () => {
    expect(parseRangeParam("1y")).toBe("1y");
    expect(parseRangeParam("3y")).toBe("3y");
    expect(parseRangeParam("5y")).toBe("5y");
    expect(parseRangeParam("all")).toBe("all");
    expect(parseRangeParam(["3y", "1y"])).toBe("3y");
    expect(parseRangeParam("nonsense")).toBe("all");
    expect(parseRangeParam(undefined)).toBe("all");
  });

  test("parseGroupParam accepts the three axes, else 'direction' (the default)", () => {
    expect(parseGroupParam("direction")).toBe("direction");
    expect(parseGroupParam("rung")).toBe("rung");
    expect(parseGroupParam("instrument")).toBe("instrument");
    expect(parseGroupParam(["rung", "instrument"])).toBe("rung");
    expect(parseGroupParam("nonsense")).toBe("direction");
    expect(parseGroupParam(undefined)).toBe("direction");
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
    expect(
      resolveOwnershipSplit({
        activeMembers: [jose],
        preset: "even",
        shortfall: "complete-to-full-ownership",
      }),
    ).toEqual([{ memberId: "member_jose", shareBps: 10_000 }]);
  });

  test("the scope preset gives 100% to the active scope member", () => {
    expect(
      resolveOwnershipSplit({
        activeMembers: [ana, jose],
        scopeMemberId: "member_jose",
        preset: "scope",
        shortfall: "complete-to-full-ownership",
      }),
    ).toEqual([{ memberId: "member_jose", shareBps: 10_000 }]);
  });

  test("the even preset splits equally and totals 100%", () => {
    expect(
      resolveOwnershipSplit({
        activeMembers: [ana, jose],
        preset: "even",
        shortfall: "complete-to-full-ownership",
      }),
    ).toEqual([
      { memberId: "member_ana", shareBps: 5_000 },
      { memberId: "member_jose", shareBps: 5_000 },
    ]);
  });

  test("an even split of three distributes the remainder to total exactly 100%", () => {
    const split = resolveOwnershipSplit({
      activeMembers: [ana, jose, lia],
      preset: "even",
      shortfall: "complete-to-full-ownership",
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
        shortfall: "complete-to-full-ownership",
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
      shortfall: "complete-to-full-ownership",
    });
    expect(total(split)).toBe(10_000);
    expect(split.find((share) => share.memberId === "member_jose")?.shareBps).toBe(7_000);
  });

  test("the custom preset preserves an explicit split below 100%", () => {
    const split = resolveOwnershipSplit({
      activeMembers: [ana, jose],
      preset: "custom",
      customBps: { member_ana: 3_000, member_jose: 4_000 },
      shortfall: "complete-to-full-ownership",
    });

    expect(split).toEqual([
      { memberId: "member_ana", shareBps: 3_000 },
      { memberId: "member_jose", shareBps: 4_000 },
    ]);
  });

  test("the custom preset preserves an explicit split above 100%", () => {
    const split = resolveOwnershipSplit({
      activeMembers: [ana, jose],
      preset: "custom",
      customBps: { member_ana: 6_000, member_jose: 6_000 },
      shortfall: "complete-to-full-ownership",
    });

    expect(split).toEqual([
      { memberId: "member_ana", shareBps: 6_000 },
      { memberId: "member_jose", shareBps: 6_000 },
    ]);
  });
});

describe("ownership validation (domain checkOwnershipSplit + intake message map)", () => {
  const workspace: Workspace = {
    baseCurrency: "EUR",
    mode: "household",
    members,
    groups: [],
  };

  function splitError(shares: Parameters<typeof checkOwnershipSplit>[1]): string | null {
    const violation = checkOwnershipSplit(workspace, shares);
    return violation ? mapDomainViolation(violation) : null;
  }

  test("accepts shares that add up to 100%", () => {
    expect(
      splitError([
        { memberId: "member_ana", shareBps: 2_500 },
        { memberId: "member_jose", shareBps: 7_500 },
      ]),
    ).toBeNull();
    expect(splitError([{ memberId: "member_ana", shareBps: 10_000 }])).toBeNull();
  });

  test("rejects shares that do not add up to 100% with a user-facing message", () => {
    const error = splitError([
      { memberId: "member_ana", shareBps: 6_000 },
      { memberId: "member_jose", shareBps: 3_000 },
    ]);
    expect(error).toContain("100%");
  });

  test("rejects shares that exceed 100%", () => {
    expect(
      splitError([
        { memberId: "member_ana", shareBps: 10_000 },
        { memberId: "member_jose", shareBps: 5_000 },
      ]),
    ).toContain("100%");
  });
});

describe("asset and liability commands", () => {
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
    expect(okMessage("deleted_recoverable")).toBe("Eliminado — recuperable en Papelera.");
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
  test("pricesRefreshedRedirectUrl encodes each failure symbol and reason", () => {
    const url = pricesRefreshedRedirectUrl("/?scope=household", {
      failures: [
        { symbol: "ACME", reason: "Símbolo no encontrado en el proveedor" },
        { symbol: "FOO", reason: "El proveedor no devolvió cotización" },
      ],
      updated: 2,
    });
    const params = searchParamsOf(url);

    expect(params["ok"]).toBe("prices_refreshed");
    expect(params["updated"]).toBe("2");
    expect(params["failed"]).toBe(
      "ACME:Símbolo no encontrado en el proveedor|FOO:El proveedor no devolvió cotización",
    );
  });

  test("resolveOkMessage reports the count and each failed symbol with its reason", () => {
    const url = pricesRefreshedRedirectUrl("/", {
      failures: [{ symbol: "ACME", reason: "Símbolo no encontrado en el proveedor" }],
      updated: 2,
    });

    expect(resolveOkMessage(searchParamsOf(url))).toBe(
      "Precios actualizados: 2. Con error: ACME (Símbolo no encontrado en el proveedor).",
    );
    expect(
      resolveOkMessage(
        searchParamsOf(pricesRefreshedRedirectUrl("/", { failures: [], updated: 3 })),
      ),
    ).toBe("Precios actualizados: 3.");
  });

  test("resolveOkMessage shows the bare symbol when no reason was recorded", () => {
    const url = pricesRefreshedRedirectUrl("/", {
      failures: [{ symbol: "ACME", reason: "" }],
      updated: 0,
    });

    expect(resolveOkMessage(searchParamsOf(url))).toBe(
      "Precios actualizados: 0. Con error: ACME.",
    );
  });

  test("resolveOkMessage explains when there was nothing to refresh", () => {
    expect(
      resolveOkMessage(
        searchParamsOf(pricesRefreshedRedirectUrl("/", { failures: [], updated: 0 })),
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

describe("ownership split violation message — specific sum named", () => {
  const workspace: Workspace = {
    baseCurrency: "EUR",
    mode: "household",
    members,
    groups: [],
  };

  function splitError(shares: Parameters<typeof checkOwnershipSplit>[1]): string | null {
    const violation = checkOwnershipSplit(workspace, shares);
    return violation ? mapDomainViolation(violation) : null;
  }

  test("returns null when shares total exactly 10000 bps", () => {
    expect(
      splitError([
        { memberId: "member_ana", shareBps: 2_500 },
        { memberId: "member_jose", shareBps: 7_500 },
      ]),
    ).toBeNull();
  });

  test("rejects 99.9% (9990 bps) and names the actual sum", () => {
    const error = splitError([
      { memberId: "member_ana", shareBps: 4_995 },
      { memberId: "member_jose", shareBps: 4_995 },
    ]);
    expect(error).toContain("99.9");
    expect(error).toContain("100%");
  });

  test("rejects 100.1% (10010 bps) and names the actual sum", () => {
    const error = splitError([
      { memberId: "member_ana", shareBps: 5_005 },
      { memberId: "member_jose", shareBps: 5_005 },
    ]);
    expect(error).toContain("100.1");
    expect(error).toContain("100%");
  });

  test("rejects 110% and names the actual sum in the message", () => {
    const error = splitError([
      { memberId: "member_ana", shareBps: 5_500 },
      { memberId: "member_jose", shareBps: 5_500 },
    ]);
    // Message must contain the actual sum percentage
    expect(error).toContain("110");
    expect(error).toContain("100%");
  });

  test("accepts exactly 100% (10000 bps) for a single member", () => {
    expect(splitError([{ memberId: "member_ana", shareBps: 10_000 }])).toBeNull();
  });
});

describe("parseAssetCommandStrict — required name, no ghost defaults", () => {
  test("returns the parsed command when name is provided", () => {
    const result = parseAssetCommandStrict(
      form({
        acquisitionDate: "2024-01-01",
        acquisitionValue: "200000",
        name: "Casa",
        type: "real_estate",
        liquidityTier: "housing",
      }),
      members,
      1,
      "2026-01-01",
    );
    expect(result).toEqual({
      ok: true,
      command: expect.objectContaining({ name: "Casa" }),
    });
  });

  test("uses acquisition price as the base value for real estate", () => {
    const result = parseAssetCommandStrict(
      form({
        acquisitionDate: "2020-05-10",
        acquisitionValue: "180000",
        currentValue: "999999",
        initialAdjustsPriorCurve: "on",
        initialValuationDate: "2024-03-15",
        initialValuationValue: "210000",
        name: "Casa",
        rate: "3",
        type: "real_estate",
      }),
      members,
      1,
      "2026-01-01",
    );

    expect(result).toEqual({
      ok: true,
      command: expect.objectContaining({
        acquisitionDate: "2020-05-10",
        acquisitionValueMinor: 18_000_000,
        annualAppreciationRate: "0.03",
        currentValueMinor: 18_000_000,
        initialValuation: {
          adjustsPriorCurve: true,
          valuationDate: "2024-03-15",
          valueMinor: 21_000_000,
        },
        name: "Casa",
      }),
    });
  });

  test("requires acquisition date and price for real estate", () => {
    const result = parseAssetCommandStrict(
      form({ name: "Casa", type: "real_estate" }),
      members,
      1,
      "2026-01-01",
    );

    expect(result).toEqual({
      ok: false,
      error: "La fecha y el precio de adquisición son obligatorios para un inmueble.",
    });
  });

  test("returns an error when name is blank", () => {
    const result = parseAssetCommandStrict(
      form({ name: "   ", type: "cash", currentValue: "100", liquidityTier: "cash" }),
      members,
      1,
      "2026-01-01",
    );
    expect(result.ok).toBe(false);
    expect("error" in result && result.error).toBeTruthy();
  });

  test("returns an error when name is missing", () => {
    const result = parseAssetCommandStrict(
      form({ type: "cash", currentValue: "100", liquidityTier: "cash" }),
      members,
      1,
      "2026-01-01",
    );
    expect(result.ok).toBe(false);
  });
});

describe("parseValueUpdatePass — value-update-pass diffing", () => {
  test("returns update commands only for changed values", () => {
    const commands = parseValueUpdatePass(
      form({ val_asset_a: "1500", val_asset_b: "2000" }),
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
      form({ val_asset_a: "1600", val_asset_b: "2000" }),
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
      form({ val_asset_a: "not-a-number", val_asset_b: "2000" }),
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
      form({ val_asset_a: "1600", val_asset_b: "2500" }),
      [
        { id: "asset_a", currentValueMinor: 150_000 },
        { id: "asset_b", currentValueMinor: 200_000 },
      ],
    );
    expect(commands).toHaveLength(2);
    expect(commands.find((c) => c.id === "asset_a")).toEqual({
      id: "asset_a",
      newValueMinor: 160_000,
    });
    expect(commands.find((c) => c.id === "asset_b")).toEqual({
      id: "asset_b",
      newValueMinor: 250_000,
    });
  });
});

describe("okMessage — specific catalog keys for intake v2", () => {
  test("asset_added maps to the static asset-created message", () => {
    expect(okMessage("asset_added")).toBe("Activo añadido.");
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

// === #55 empezar ===

import { parseEmpezarSolo, parseEmpezarHogar } from "./intake";

describe("parseEmpezarSolo — individual path", () => {
  test("returns ok with a single member from the name field", () => {
    const result = parseEmpezarSolo(form({ name: "Ana" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.mode).toBe("individual");
    expect(result.command.members).toHaveLength(1);
    expect(result.command.members[0]!.name).toBe("Ana");
  });

  test("trims whitespace from the name", () => {
    const result = parseEmpezarSolo(form({ name: "  José  " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.members[0]!.name).toBe("José");
  });

  test("rejects a blank name with a user-facing error", () => {
    const result = parseEmpezarSolo(form({ name: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeTruthy();
  });

  test("rejects a missing name field", () => {
    const result = parseEmpezarSolo(form({}));
    expect(result.ok).toBe(false);
  });

  test("generates a stable deterministic member id", () => {
    const r1 = parseEmpezarSolo(form({ name: "Ana" }));
    const r2 = parseEmpezarSolo(form({ name: "Ana" }));
    expect(r1).toEqual(r2);
  });
});

describe("parseEmpezarHogar — household path", () => {
  test("returns ok with multiple members from one-per-line textarea", () => {
    const result = parseEmpezarHogar(form({ memberNames: "Ana\nJose\nLuz" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.mode).toBe("household");
    expect(result.command.members.map((m) => m.name)).toEqual(["Ana", "Jose", "Luz"]);
  });

  test("filters blank lines silently", () => {
    const result = parseEmpezarHogar(form({ memberNames: "Ana\n\nJose\n  \nLuz" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.members.map((m) => m.name)).toEqual(["Ana", "Jose", "Luz"]);
  });

  test("trims whitespace from each name", () => {
    const result = parseEmpezarHogar(form({ memberNames: "  Ana  \n  Jose  " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.members.map((m) => m.name)).toEqual(["Ana", "Jose"]);
  });

  test("rejects entirely empty input with a user-facing error", () => {
    const result = parseEmpezarHogar(form({ memberNames: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeTruthy();
  });

  test("rejects input that is only blank lines", () => {
    const result = parseEmpezarHogar(form({ memberNames: "\n\n   \n" }));
    expect(result.ok).toBe(false);
  });

  test("generates stable deterministic member ids", () => {
    const r1 = parseEmpezarHogar(form({ memberNames: "Ana\nJose" }));
    const r2 = parseEmpezarHogar(form({ memberNames: "Ana\nJose" }));
    expect(r1).toEqual(r2);
  });

  test("accepts a single name (household with one person is valid)", () => {
    const result = parseEmpezarHogar(form({ memberNames: "Ana" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.members).toHaveLength(1);
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
    const result = parseInvestmentAssetCommandStrict(form({ name: "ACME" }), members, 1);
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

  test("parses provider symbol, provider, and liquidity tier for pension plans", () => {
    const result = parseInvestmentAssetCommandStrict(
      form({
        liquidityTier: "term-locked",
        name: "MyInvestor S&P 500 PP",
        priceProvider: "finect",
        providerSymbol: "N5394",
      }),
      members,
      1,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.liquidityTier).toBe("term-locked");
    expect(result.command.priceProvider).toBe("finect");
    expect(result.command.providerSymbol).toBe("N5394");
  });
});

describe("parseRouteOperationCommand — asset id from route, strict field errors", () => {
  test("returns ok command for valid buy", () => {
    const result = parseRouteOperationCommand(
      form({
        kind: "buy",
        executedAt: "2026-01-15",
        units: "5",
        pricePerUnit: "100",
        fees: "9,99",
      }),
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
      form({
        name: "ACME Updated",
        unitSymbol: "acme.us",
        isin: "US0231351067",
        manualPricePerUnit: "15,00",
      }),
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
    const result = parseUpdateInvestmentCommand(form({ name: "  " }), "asset_acme");
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

  test("parses provider symbol, provider, and liquidity tier", () => {
    const result = parseUpdateInvestmentCommand(
      form({
        liquidityTier: "term-locked",
        name: "Plan renombrado",
        priceProvider: "finect",
        providerSymbol: "N5394",
      }),
      "asset_plan",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.liquidityTier).toBe("term-locked");
    expect(result.command.priceProvider).toBe("finect");
    expect(result.command.providerSymbol).toBe("N5394");
  });
});

describe("parseValuationAnchorStrict", () => {
  const TODAY = "2026-06-12";

  test("parses a valid past market-appraisal anchor", () => {
    const result = parseValuationAnchorStrict(
      form({
        adjustsPriorCurve: "on",
        valuationDate: "2024-01-01",
        anchorValue: "100000",
      }),
      "piso",
      42,
      TODAY,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.assetId).toBe("piso");
    expect(result.command.valuationDate).toBe("2024-01-01");
    expect(result.command.valueMinor).toBe(100_000_00);
    expect(result.command.adjustsPriorCurve).toBe(true);
    expect(result.command.id).toContain("anchor_");
  });

  test("treats a missing adjustsPriorCurve checkbox as an improvement", () => {
    const result = parseValuationAnchorStrict(
      form({ valuationDate: "2024-06-01", anchorValue: "10000" }),
      "piso",
      1,
      TODAY,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.adjustsPriorCurve).toBe(false);
  });

  test("rejects a missing date", () => {
    const result = parseValuationAnchorStrict(
      form({ anchorValue: "100000" }),
      "piso",
      1,
      TODAY,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("fecha");
  });

  test("rejects a malformed date", () => {
    const result = parseValuationAnchorStrict(
      form({ valuationDate: "01/01/2024", anchorValue: "100000" }),
      "piso",
      1,
      TODAY,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("fecha");
  });

  test("rejects a future date", () => {
    const result = parseValuationAnchorStrict(
      form({ valuationDate: "2026-12-31", anchorValue: "100000" }),
      "piso",
      1,
      TODAY,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("futura");
  });

  test("accepts today's date as non-future", () => {
    const result = parseValuationAnchorStrict(
      form({ valuationDate: TODAY, anchorValue: "100000" }),
      "piso",
      1,
      TODAY,
    );

    expect(result.ok).toBe(true);
  });

  test("rejects a non-positive value", () => {
    const zero = parseValuationAnchorStrict(
      form({ valuationDate: "2024-01-01", anchorValue: "0" }),
      "piso",
      1,
      TODAY,
    );
    expect(zero.ok).toBe(false);
    if (zero.ok) return;
    expect(zero.error).toContain("valor");

    const negative = parseValuationAnchorStrict(
      form({ valuationDate: "2024-01-01", anchorValue: "-5" }),
      "piso",
      1,
      TODAY,
    );
    expect(negative.ok).toBe(false);
  });

  test("rejects an unparseable value", () => {
    const result = parseValuationAnchorStrict(
      form({ valuationDate: "2024-01-01", anchorValue: "abc" }),
      "piso",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
  });

  test("parses an es-ES localized value", () => {
    const result = parseValuationAnchorStrict(
      form({ valuationDate: "2024-01-01", anchorValue: "120.000,50" }),
      "piso",
      1,
      TODAY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.valueMinor).toBe(120_000_50);
  });
});

describe("parseDebtModelStrict", () => {
  test("accepts the three known models", () => {
    for (const model of ["amortizable", "revolving", "informal"] as const) {
      const result = parseDebtModelStrict(form({ debtModel: model }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.model).toBe(model);
    }
  });

  test("treats an empty value as clearing the model (null)", () => {
    const result = parseDebtModelStrict(form({ debtModel: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBeNull();
  });

  test("treats a missing value as clearing the model (null)", () => {
    const result = parseDebtModelStrict(form({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBeNull();
  });

  test("rejects an unknown model", () => {
    const result = parseDebtModelStrict(form({ debtModel: "weird" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("modelo");
  });
});

describe("parseAmortizationPlanStrict", () => {
  const TODAY = "2026-06-12";

  test("parses a valid plan, converting percent to a decimal rate and EUR to minor", () => {
    const result = parseAmortizationPlanStrict(
      form({
        initialCapital: "200000",
        annualInterestRate: "2,5",
        termMonths: "360",
        disbursementDate: "2020-01-15",
        firstPaymentDate: "2020-03-01",
      }),
      "loan",
      7,
      TODAY,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.liabilityId).toBe("loan");
    expect(result.command.initialCapitalMinor).toBe(200_000_00);
    expect(result.command.annualInterestRate).toBe("0.025");
    expect(result.command.termMonths).toBe(360);
    // Two dates captured explicitly (ADR 0019, #189): a mid-month firma and a
    // 1st-of-month first payment, taken verbatim — never re-derived.
    expect(result.command.disbursementDate).toBe("2020-01-15");
    expect(result.command.firstPaymentDate).toBe("2020-03-01");
    expect(result.command.id).toContain("plan_");
  });

  test("rejects a future disbursement date", () => {
    const result = parseAmortizationPlanStrict(
      form({
        initialCapital: "200000",
        annualInterestRate: "3",
        termMonths: "360",
        disbursementDate: "2027-01-01",
        firstPaymentDate: "2027-03-01",
      }),
      "loan",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("futura");
  });

  test("rejects a non-positive capital", () => {
    const result = parseAmortizationPlanStrict(
      form({
        initialCapital: "0",
        annualInterestRate: "3",
        termMonths: "360",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-03-01",
      }),
      "loan",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("capital");
  });

  test("rejects a non-integer or non-positive term", () => {
    const fractional = parseAmortizationPlanStrict(
      form({
        initialCapital: "200000",
        annualInterestRate: "3",
        termMonths: "12,5",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-03-01",
      }),
      "loan",
      1,
      TODAY,
    );
    expect(fractional.ok).toBe(false);

    const zero = parseAmortizationPlanStrict(
      form({
        initialCapital: "200000",
        annualInterestRate: "3",
        termMonths: "0",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-03-01",
      }),
      "loan",
      1,
      TODAY,
    );
    expect(zero.ok).toBe(false);
    if (zero.ok) return;
    expect(zero.error).toContain("plazo");
  });

  test("rejects a negative interest rate", () => {
    const result = parseAmortizationPlanStrict(
      form({
        initialCapital: "200000",
        annualInterestRate: "-1",
        termMonths: "360",
        disbursementDate: "2020-01-01",
        firstPaymentDate: "2020-03-01",
      }),
      "loan",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("tipo");
  });

  test("rejects a missing disbursement date", () => {
    const result = parseAmortizationPlanStrict(
      form({
        initialCapital: "200000",
        annualInterestRate: "3",
        termMonths: "360",
        firstPaymentDate: "2020-03-01",
      }),
      "loan",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("firma");
  });

  test("rejects a missing first-payment date", () => {
    const result = parseAmortizationPlanStrict(
      form({
        initialCapital: "200000",
        annualInterestRate: "3",
        termMonths: "360",
        disbursementDate: "2020-01-15",
      }),
      "loan",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("primer pago");
  });

  test("rejects a first payment before the disbursement", () => {
    const result = parseAmortizationPlanStrict(
      form({
        initialCapital: "200000",
        annualInterestRate: "3",
        termMonths: "360",
        disbursementDate: "2020-01-15",
        firstPaymentDate: "2020-01-10",
      }),
      "loan",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("anterior a la fecha de firma");
  });

  test("accepts a first payment on the same day as the disbursement", () => {
    const result = parseAmortizationPlanStrict(
      form({
        initialCapital: "200000",
        annualInterestRate: "3",
        termMonths: "360",
        disbursementDate: "2020-01-15",
        firstPaymentDate: "2020-01-15",
      }),
      "loan",
      1,
      TODAY,
    );
    expect(result.ok).toBe(true);
  });
});

describe("parseInterestRateRevisionStrict", () => {
  const TODAY = "2026-06-12";

  test("parses a valid revision, converting percent to a decimal rate", () => {
    const result = parseInterestRateRevisionStrict(
      form({ revisionDate: "2024-01-01", newAnnualInterestRate: "3,5" }),
      "plan1",
      9,
      TODAY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.planId).toBe("plan1");
    expect(result.command.revisionDate).toBe("2024-01-01");
    expect(result.command.newAnnualInterestRate).toBe("0.035");
    expect(result.command.id).toContain("rev_");
  });

  test("rejects a future revision date", () => {
    const result = parseInterestRateRevisionStrict(
      form({ revisionDate: "2027-01-01", newAnnualInterestRate: "3" }),
      "plan1",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("futura");
  });

  test("rejects a negative rate", () => {
    const result = parseInterestRateRevisionStrict(
      form({ revisionDate: "2024-01-01", newAnnualInterestRate: "-1" }),
      "plan1",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("tipo");
  });

  test("rejects a missing date", () => {
    const result = parseInterestRateRevisionStrict(
      form({ newAnnualInterestRate: "3" }),
      "plan1",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("fecha");
  });
});

describe("parseBalanceAnchorStrict", () => {
  const TODAY = "2026-06-12";

  test("parses a valid past anchor, converting EUR to minor units", () => {
    const result = parseBalanceAnchorStrict(
      form({ anchorDate: "2024-03-15", balance: "12.500,50" }),
      "loan",
      3,
      TODAY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command.liabilityId).toBe("loan");
    expect(result.command.anchorDate).toBe("2024-03-15");
    expect(result.command.balanceMinor).toBe(12_500_50);
    expect(result.command.id).toContain("banchor_");
  });

  test("accepts today's date as non-future", () => {
    const result = parseBalanceAnchorStrict(
      form({ anchorDate: TODAY, balance: "1000" }),
      "loan",
      1,
      TODAY,
    );
    expect(result.ok).toBe(true);
  });

  test("rejects a future date", () => {
    const result = parseBalanceAnchorStrict(
      form({ anchorDate: "2027-01-01", balance: "1000" }),
      "loan",
      1,
      TODAY,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("futura");
  });

  test("rejects a non-positive balance", () => {
    const zero = parseBalanceAnchorStrict(
      form({ anchorDate: "2024-01-01", balance: "0" }),
      "loan",
      1,
      TODAY,
    );
    expect(zero.ok).toBe(false);
    if (zero.ok) return;
    expect(zero.error).toContain("saldo");
  });

  test("rejects a missing date", () => {
    const result = parseBalanceAnchorStrict(form({ balance: "1000" }), "loan", 1, TODAY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("fecha");
  });
});

describe("parseAppreciationRateStrict", () => {
  test("converts a whole percent to a decimal string", () => {
    const result = parseAppreciationRateStrict(form({ rate: "3" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rate).toBe("0.03");
  });

  test("converts a fractional percent to a decimal string", () => {
    const result = parseAppreciationRateStrict(form({ rate: "2,5" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rate).toBe("0.025");
  });

  test("treats a blank rate as a clear (null)", () => {
    const result = parseAppreciationRateStrict(form({ rate: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rate).toBeNull();
  });

  test("rejects a negative rate", () => {
    const result = parseAppreciationRateStrict(form({ rate: "-1" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("tasa");
  });

  test("rejects a non-numeric rate", () => {
    const result = parseAppreciationRateStrict(form({ rate: "abc" }));
    expect(result.ok).toBe(false);
  });
});
