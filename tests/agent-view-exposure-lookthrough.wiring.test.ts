import { GET as getHolding } from "@web/api/v1/agent-view/holdings/[holdingId]/route";
import { GET as getFinancialContext } from "@web/api/v1/agent-view/scopes/[scopeId]/financial-context/route";
import { GET as getScopes } from "@web/api/v1/agent-view/scopes/route";
import { createControlPlaneStore, createWorthlineStoreUnsafe } from "@worthline/db";
import type { ExposureLookthrough, ExposureProfile } from "@worthline/domain";
import { lookThroughExposure } from "@worthline/domain";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupTempDirs, tempDatabasePath } from "./helpers";

const ORIGINAL_DB_PATH = process.env.WORTHLINE_DB_PATH;
const ORIGINAL_TOKEN = process.env.WORTHLINE_AGENT_VIEW_TOKEN;
const ORIGINAL_CONTROL_PLANE_DB_URL = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;

afterEach(() => {
  if (ORIGINAL_DB_PATH === undefined) {
    delete process.env.WORTHLINE_DB_PATH;
  } else {
    process.env.WORTHLINE_DB_PATH = ORIGINAL_DB_PATH;
  }

  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.WORTHLINE_AGENT_VIEW_TOKEN;
  } else {
    process.env.WORTHLINE_AGENT_VIEW_TOKEN = ORIGINAL_TOKEN;
  }

  if (ORIGINAL_CONTROL_PLANE_DB_URL === undefined) {
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
  } else {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = ORIGINAL_CONTROL_PLANE_DB_URL;
  }

  cleanupTempDirs();
});

function eur(amountMinor: number) {
  return { amountMinor, currency: "EUR" };
}

function authedRequest(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1${path}`, {
    headers: { authorization: "Bearer local-agent-token" },
    method: "GET",
  });
}

interface ScopeRef {
  id: string;
  type: string;
}

async function householdScopeId(): Promise<string> {
  const body = await (await getScopes(authedRequest("/api/v1/agent-view/scopes"))).json();
  const scopes = body.data as ScopeRef[];
  return scopes.find((scope) => scope.type === "household")!.id;
}

async function financialContext(scopeId: string) {
  const response = await getFinancialContext(
    authedRequest(`/api/v1/agent-view/scopes/${scopeId}/financial-context`),
    { params: Promise.resolve({ scopeId }) },
  );
  return { body: await response.json(), response };
}

async function holding(holdingId: string) {
  const response = await getHolding(
    authedRequest(`/api/v1/agent-view/holdings/${holdingId}`),
    { params: Promise.resolve({ holdingId }) },
  );
  return { body: await response.json(), response };
}

interface HoldingSummaryRow {
  id: string;
  label: string;
}

async function holdingIdByLabel(scopeId: string, label: string): Promise<string> {
  const { body } = await financialContext(scopeId);
  const items = body.data.holdings.items as HoldingSummaryRow[];
  return items.find((row) => row.label === label)!.id;
}

const owner = [{ memberId: "member_jose", shareBps: 10_000 }];

const US_ETF_ISIN = "IE00B5BMR087";
const US_ETF_PROFILE: ExposureProfile = {
  key: US_ETF_ISIN,
  source: "user",
  declaredAt: null,
  trackedIndex: "S&P 500",
  ter: "0.0007",
  hedged: false,
  breakdowns: {
    geography: { us: "1" },
    currency: { USD: "1" },
    assetClass: { equity: "1" },
  },
};

/**
 * Seed a household with a US-tracking ETF (isin), a cash account, and a crypto
 * holding. The exposure profile now lives in the GLOBAL catalog (control plane,
 * ADR 0058), so — unless `withCatalog` is false — it is seeded there and the
 * control-plane URL is configured for the read path.
 */
async function seedExposure(
  options: { withCatalog?: boolean; seedProfile?: boolean } = {},
): Promise<void> {
  const withCatalog = options.withCatalog ?? true;
  const seedProfile = options.seedProfile ?? true;
  const databasePath = tempDatabasePath("worthline-agent-view-exposure-");
  process.env.WORTHLINE_DB_PATH = databasePath;
  process.env.WORTHLINE_AGENT_VIEW_TOKEN = "local-agent-token";

  const store = await createWorthlineStoreUnsafe({ databasePath });
  await store.workspace.initializeWorkspace({
    members: [{ id: "member_jose", name: "Jose" }],
    mode: "individual",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_etf",
    instrument: "etf",
    isin: US_ETF_ISIN,
    liquidityTier: "market",
    name: "S&P 500 ETF",
    ownership: owner,
    providerSymbol: "CSPX.L",
  });
  // Value the ETF via a single opening BUY (10 units @ 200.00 = 2_000_00).
  await store.command.recordInvestmentOperation(
    {
      assetId: "asset_etf",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_etf",
      kind: "buy",
      pricePerUnit: "200.00",
      units: "10",
    },
    { today: "2026-06-19" },
  );
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 3_000_00,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Cuenta",
    ownership: owner,
    type: "cash",
  });
  await store.assets.createInvestmentAsset({
    currency: "EUR",
    id: "asset_btc",
    instrument: "crypto",
    liquidityTier: "market",
    name: "Bitcoin",
    ownership: owner,
    providerSymbol: "bitcoin",
  });
  await store.command.recordInvestmentOperation(
    {
      assetId: "asset_btc",
      currency: "EUR",
      executedAt: "2026-01-10",
      feesMinor: 0,
      id: "op_btc",
      kind: "buy",
      pricePerUnit: "1000.00",
      units: "1",
    },
    { today: "2026-06-19" },
  );
  store.close();

  if (!withCatalog) {
    // No control-plane URL: the catalog resolves `not_configured` (never the
    // per-workspace table), so the look-through must degrade explicitly.
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    return;
  }

  const controlPlanePath = tempDatabasePath("worthline-control-plane-exposure-");
  process.env.WORTHLINE_CONTROL_PLANE_DB_URL = `file:${controlPlanePath}`;
  const controlPlane = await createControlPlaneStore({ url: `file:${controlPlanePath}` });
  // The catalog is configured either way; `seedProfile` decides whether the
  // ETF's identity actually has a row (available-with-row vs available-empty).
  if (seedProfile) {
    await controlPlane.createGlobalExposureProfile({
      identity: { isin: US_ETF_ISIN },
      breakdowns: {
        geography: { us: "1" },
        currency: { USD: "1" },
        assetClass: { equity: "1" },
      },
      ter: "0.0007",
      trackedIndex: "S&P 500",
    });
  }
  controlPlane.close();
}

describe("agent-view exposure look-through (PRD #539 S2 / #542, catalog #711 S3)", () => {
  test("financial-context breakdowns reconcile with a direct lookThroughExposure call", async () => {
    await seedExposure();
    const scopeId = await householdScopeId();

    const { body } = await financialContext(scopeId);
    const exposure = body.data.exposure;
    const grossAssets = body.data.summary.grossAssets as {
      amountMinor: number;
      currency: string;
    };

    // Reproduce the S0 aggregation directly on the same seeded inputs.
    const expected: ExposureLookthrough = lookThroughExposure({
      baseCurrency: "EUR",
      grossAssets,
      holdings: [
        {
          currency: "EUR",
          id: "asset_etf",
          instrument: "etf",
          isin: US_ETF_ISIN,
          providerSymbol: "CSPX.L",
          valueMinor: 2_000_00,
        },
        {
          currency: "EUR",
          id: "asset_cash",
          instrument: "current_account",
          isin: null,
          providerSymbol: null,
          valueMinor: 3_000_00,
        },
        {
          currency: "EUR",
          id: "asset_btc",
          instrument: "crypto",
          isin: null,
          providerSymbol: "bitcoin",
          valueMinor: 1_000_00,
        },
      ],
      profiles: new Map([[US_ETF_ISIN, US_ETF_PROFILE]]),
    });

    expect(exposure.byGeography).toEqual(expected.geography);
    expect(exposure.byCurrency).toEqual(expected.currency);
    expect(exposure.byAssetClass).toEqual(expected.assetClass);
    expect(exposure.currencyRisk).toEqual(expected.currencyRisk);

    // The catalog was available: no `catalogUnavailable` discriminator anywhere.
    expect(exposure.byGeography.coverage.catalogUnavailable).toBeUndefined();

    // The existing exposure block is untouched.
    expect(exposure.byInstrument).toBeDefined();
    expect(exposure.byLiquidityTier).toBeDefined();
    expect(exposure.topHoldings).toBeDefined();
    expect(exposure.concentration).toBeDefined();
  });

  test("a crypto holding lands in geography not-applicable, never unknown or missing", async () => {
    await seedExposure();
    const scopeId = await householdScopeId();

    const { body } = await financialContext(scopeId);
    const geo = body.data.exposure.byGeography;

    // Crypto (1_000_00) + cash (3_000_00) are geography-not-applicable; the ETF
    // (2_000_00) is classified as US. Nothing is unknown.
    expect(geo.coverage.classified).toEqual(eur(2_000_00));
    expect(geo.coverage.notApplicable).toEqual(eur(4_000_00));
    expect(geo.coverage.unknown).toEqual(eur(0));

    const us = geo.slices.find((slice: { key: string }) => slice.key === "us");
    expect(us.value).toEqual(eur(2_000_00));
  });

  test("get_holding_detail returns the resolved profile for a holding that has one", async () => {
    await seedExposure();
    const scopeId = await householdScopeId();
    const etfId = await holdingIdByLabel(scopeId, "S&P 500 ETF");

    const { body } = await holding(etfId);

    expect(body.data.exposureProfile).toEqual({
      trackedIndex: "S&P 500",
      ter: "0.0007",
      hedged: false,
      breakdowns: {
        geography: { us: "1" },
        currency: { USD: "1" },
        assetClass: { equity: "1" },
      },
    });
    // A resolved profile carries no absence discriminator.
    expect(body.data.exposureProfileStatus).toBeUndefined();
  });

  test("get_holding_detail signals absence (null) for a holding with no profile", async () => {
    await seedExposure();
    const scopeId = await householdScopeId();

    // Crypto takes no hand-entered profile (not `canHandEnterExposureProfile`),
    // so its absence carries no missing/unavailable distinction — a plain null.
    const btcId = await holdingIdByLabel(scopeId, "Bitcoin");
    const btc = await holding(btcId);
    expect(btc.body.data.exposureProfile ?? null).toBeNull();
    expect(btc.body.data.exposureProfileStatus).toBeUndefined();

    // A non-investment holding (cash) also has no profile — and no identity.
    const cashId = await holdingIdByLabel(scopeId, "Cuenta");
    const cash = await holding(cashId);
    expect(cash.body.data.exposureProfile ?? null).toBeNull();
    expect(cash.body.data.exposureProfileStatus).toBeUndefined();
  });

  test("catalog available but empty: an eligible security reports profile_missing", async () => {
    // Catalog is configured and readable, but has no row for the ETF's ISIN.
    await seedExposure({ seedProfile: false });
    const scopeId = await householdScopeId();
    const etfId = await holdingIdByLabel(scopeId, "S&P 500 ETF");

    const { body } = await holding(etfId);
    expect(body.data.exposureProfile ?? null).toBeNull();
    // Known identity + readable catalog + no row → profile_missing, NOT catalog_unavailable.
    expect(body.data.exposureProfileStatus).toBe("profile_missing");
  });

  test("catalog unavailable: net worth resolves, look-through/holding degrade to catalog_unavailable", async () => {
    // No control-plane URL configured — the catalog is `not_configured`, NOT empty.
    await seedExposure({ withCatalog: false });
    const scopeId = await householdScopeId();

    const { body, response } = await financialContext(scopeId);
    expect(response.status).toBe(200);
    // Patrimonio / net worth still resolve (they never read the catalog).
    expect(body.data.summary.grossAssets).toEqual(eur(6_000_00));

    // The look-through classifies nothing against reference data and says so —
    // "catalog down", not "profiles missing".
    expect(body.data.exposure.byGeography.coverage.catalogUnavailable).toBe(
      "not_configured",
    );
    expect(body.data.exposure.byAssetClass.coverage.catalogUnavailable).toBe(
      "not_configured",
    );

    // Holding detail: a KNOWN identity reports catalog_unavailable, not profile_missing.
    const etfId = await holdingIdByLabel(scopeId, "S&P 500 ETF");
    const { body: etf } = await holding(etfId);
    expect(etf.data.exposureProfile ?? null).toBeNull();
    expect(etf.data.exposureProfileStatus).toBe("catalog_unavailable");
    // The tracked index lives in the catalog, so the benchmark inherits the signal.
    expect(etf.data.vsBenchmark.unavailableReason).toBe("catalog_unavailable");
  });
});
