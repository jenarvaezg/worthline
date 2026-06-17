/**
 * Numista API client — auth (PRD #160 / #163, ADR 0016).
 *
 * Reading a Numista collection needs an OAuth2 token. ADR 0016: the
 * `client_credentials` grant with `scope=view_collection` reads your OWN
 * collection non-interactively (the API key alone 403s on collected_items).
 * These tests pin the token mint request and the expiry/caching decision against
 * a mocked `fetch`, the way the Stooq/CoinGecko provider tests do. The
 * collected_items RESPONSE parsing is tested separately against the committed
 * S0 fixtures (spike #161).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import collectedItemsFixture from "./__fixtures__/numista/collected-items.json";
import typeDetailFixture from "./__fixtures__/numista/type-detail.json";
import typePricesFixture from "./__fixtures__/numista/type-prices.json";
import {
  getCollectedItems,
  getPrices,
  getTypeDetail,
  isTokenValid,
  mapCollectedItem,
  mintNumistaToken,
  numismaticEstimateMinor,
} from "./numista";

// Per Numista's docs, the client_credentials grant authenticates "to your own
// account" with ONLY grant_type + scope — the API key (header) is the credential;
// there is NO separate client_id/client_secret in the body.
const creds = { apiKey: "KEY" };

function okJson(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

describe("mintNumistaToken — client_credentials + scope=view_collection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the client_credentials grant (api key in header) and parses the token + expiry", async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "tok-123",
        token_type: "bearer",
        expires_in: 7200,
        user_id: 574660,
      }),
    } as Response);

    const token = await mintNumistaToken(creds, 1_000_000);

    expect(token.accessToken).toBe("tok-123");
    expect(token.expiresAtMs).toBe(1_000_000 + 7200 * 1000);
    // The client_credentials response carries the authenticated user's id, which
    // the collection read needs (no separate lookup).
    expect(token.userId).toBe(574660);

    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://api.numista.com/v3/oauth_token");
    const init = call[1]!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Numista-API-Key"]).toBe("KEY");
    const body = String(init.body);
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("scope=view_collection");
    // The API key is the credential (header) — no client_id/secret in the body.
    expect(body).not.toContain("client_id");
    expect(body).not.toContain("client_secret");
  });

  it("throws a clear error when the token endpoint rejects the credentials", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);

    await expect(mintNumistaToken(creds, 0)).rejects.toThrow(/numista/i);
  });
});

describe("isTokenValid — re-mint before expiry", () => {
  const token = { accessToken: "x", expiresAtMs: 1_000_000, userId: 574660 };

  it("is valid well before expiry", () => {
    expect(isTokenValid(token, 500_000)).toBe(true);
  });

  it("is invalid after expiry", () => {
    expect(isTokenValid(token, 1_000_001)).toBe(false);
  });

  it("treats a token inside the safety margin as expired (never races expiry)", () => {
    // 60s margin: a token expiring in 30s is treated as already gone.
    expect(isTokenValid(token, 1_000_000 - 30_000)).toBe(false);
  });
});

describe("Numista readers — parse the live response shapes (fixtures, spike #161)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getCollectedItems reads the user's whole collection — coins and non-coins (bearer token + api key header)", async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValueOnce(okJson(collectedItemsFixture));

    const items = await getCollectedItems(creds, "tok-abc", 574660);

    expect(items).toHaveLength(4);
    expect(items[0]!.type.id).toBe(1493);
    expect(items[0]!.grade).toBe("unc");
    // Non-coin collectibles are mirrored too (a 1 oz silver round filed under
    // exonumia) — they are holdings with real value (#160 follow-up).
    expect(items.some((item) => item.type.category === "exonumia")).toBe(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/users/574660/collected_items");
    // The whole collection is pulled — NO category filter, so exonumia/banknotes
    // are not silently dropped.
    expect(String(url)).not.toContain("category=");
    const headers = init!.headers as Record<string, string>;
    expect(headers["Numista-API-Key"]).toBe("KEY");
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
  });

  it("getTypeDetail reads the composition text and weight", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okJson(typeDetailFixture));

    const detail = await getTypeDetail(creds, 1493);

    expect(detail.title).toContain("American Silver Eagle");
    expect(detail.compositionText).toBe("Plata 999");
    expect(detail.weightGrams).toBe(31.103);
    // The obverse thumbnail is the catalogue photo the coin gallery renders (#272 x100).
    expect(detail.obverseThumbUrl).toBe(
      "https://en.numista.com/catalogue/photos/etats-unis/1493-180.jpg",
    );
  });

  it("getTypeDetail leaves the thumbnail null when the catalogue has no obverse photo", async () => {
    const noPhoto: Record<string, unknown> = { ...typeDetailFixture };
    delete noPhoto.obverse;
    vi.mocked(fetch).mockResolvedValueOnce(okJson(noPhoto));

    const detail = await getTypeDetail(creds, 1493);

    expect(detail.obverseThumbUrl).toBeNull();
  });

  it("getPrices reads the per-grade EUR estimates", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okJson(typePricesFixture));

    const prices = await getPrices(creds, 1493, 32723);

    expect(prices.currency).toBe("EUR");
    expect(prices.prices).toContainEqual({ grade: "unc", price: 75.585 });
  });

  it("numismaticEstimateMinor matches the coin's grade to its EUR estimate", () => {
    const prices = typePricesFixture.prices;
    // 75.585 EUR → 7558 minor: 75.585 * 100 is 7558.4999… in IEEE-754, just under
    // the half, so Math.round floors it. A sub-cent quirk on an estimate — fine.
    expect(numismaticEstimateMinor(prices, "unc")).toBe(7558);
    expect(numismaticEstimateMinor(prices, "xf")).toBe(6654);
    // A grade with no estimate → null (no fabricated value).
    expect(numismaticEstimateMinor(prices, "g")).toBeNull();
  });

  it("mapCollectedItem extracts price + acquisition date when the user recorded them", () => {
    const withPrice = collectedItemsFixture.items.find((i) => i.id === 78084999)!;
    const draft = mapCollectedItem(withPrice);

    expect(draft).toMatchObject({
      catalogueId: "5678",
      issueId: 99001,
      name: "5 Pesetas Alfonso XII",
      grade: "vf",
      quantity: 2,
      purchasePriceMinor: 4050,
      purchaseDate: "2019-05-12",
      currency: "EUR",
    });
  });

  it("mapCollectedItem leaves price/date null when the user recorded none", () => {
    const noPrice = collectedItemsFixture.items.find((i) => i.id === 78084155)!;
    const draft = mapCollectedItem(noPrice);

    expect(draft.purchasePriceMinor).toBeNull();
    expect(draft.purchaseDate).toBeNull();
    expect(draft.currency).toBe("EUR");
    expect(draft.catalogueId).toBe("1493");
  });

  it("mapCollectedItem carries the coin's mint year, preferring gregorian_year (#215)", () => {
    const item = {
      id: 1,
      quantity: 1,
      type: { id: 5678, title: "5 Pesetas Alfonso XII" },
      issue: { id: 99001, year: 1888, gregorian_year: 1889 },
      grade: "vf",
    };

    // gregorian_year wins when both are present.
    expect(mapCollectedItem(item).year).toBe(1889);

    // year is the fallback when there is no gregorian_year.
    expect(mapCollectedItem({ ...item, issue: { id: 99001, year: 1888 } }).year).toBe(
      1888,
    );

    // no issue year at all → no fabricated value.
    expect(mapCollectedItem({ ...item, issue: { id: 99001 } }).year).toBeNull();

    // no issue object at all → still null (the common case).
    const noIssue = {
      id: 1,
      quantity: 1,
      type: { id: 5678, title: "5 Pesetas Alfonso XII" },
      grade: "vf",
    };
    expect(mapCollectedItem(noIssue).year).toBeNull();
  });
});
