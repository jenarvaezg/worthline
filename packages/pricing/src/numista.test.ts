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

import { isTokenValid, mintNumistaToken } from "./numista";

// Per Numista's docs, the client_credentials grant authenticates "to your own
// account" with ONLY grant_type + scope — the API key (header) is the credential;
// there is NO separate client_id/client_secret in the body.
const creds = { apiKey: "KEY" };

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
      }),
    } as Response);

    const token = await mintNumistaToken(creds, 1_000_000);

    expect(token.accessToken).toBe("tok-123");
    expect(token.expiresAtMs).toBe(1_000_000 + 7200 * 1000);

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
  const token = { accessToken: "x", expiresAtMs: 1_000_000 };

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
