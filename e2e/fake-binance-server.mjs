/**
 * Fake Binance + CoinGecko HTTP server for the Binance e2e journey (PRD #245 S7,
 * #252, ADR 0021).
 *
 * The connect/sync flow fetches Binance + CoinGecko from the Next.js SERVER
 * process (RSC server actions), which Playwright's page.route() cannot intercept.
 * So this stand-alone server serves deterministic, signature-agnostic responses,
 * and the Next.js webServer is pointed at it via WORTHLINE_BINANCE_BASE_URL /
 * WORTHLINE_COINGECKO_BASE_URL (see playwright.config.ts + packages/pricing).
 *
 * It does NOT verify the HMAC signature — any key/secret works — so the journey
 * can paste dummy credentials. The data is fixed so the journey can assert exact
 * values:
 *   - SPOT: 0.5 BTC (market rung)
 *   - LOCKED Earn: 3 ETH (term-locked rung)
 *   - funding / flexible Earn: empty
 *   - live prices: BTC 50 000 €, ETH 2 000 €  → market 25 000 €, locked 6 000 €
 *   - daily SPOT snapshots over the last ~70 days (0.5 BTC), priced 40 000 €/BTC
 *     in the history range, so the monthly backfill freezes a curve with a real
 *     start date → the detail page shows "Datos desde DD/MM/YYYY".
 *
 * Pure Node http + plain JS (.mjs) so the webServer command is a bare `node`
 * invocation with no TS runtime.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_PORT ?? 3902);

const LIVE_PRICES_EUR = { bitcoin: 50000, ethereum: 2000 };
const HISTORY_PRICE_EUR = 40000; // flat BTC history price (volatility is not the point)

const DAY_MS = 86_400_000;

/**
 * How many days of daily SPOT snapshots the fake hands back.
 *
 * TEST-ONLY OVER-PROVISION — do NOT lower this to honour Binance's real
 * `limit=30` horizon. The journey's "Datos desde" assertion needs the
 * reconstruction to yield ≥ 1 COMPLETED prior calendar month-end on EVERY day of
 * the year. At a 30-day window that breaks on the 31st of a 31-day month (the only
 * completed prior month-end is > 30 days back, so it falls outside the window and
 * below the curve start → zero frozen rows → no "Datos desde"). 70 days always
 * spans a full prior calendar month regardless of the day-of-month, so the curve
 * always has an honest start date. The real client still sends `limit=30`
 * (packages/pricing/src/binance.ts); the fake deliberately exceeds it so the test
 * is calendar-independent — faithfulness to the cap is not the point here.
 */
const SNAPSHOT_SPAN_DAYS = 70;

/** Daily SPOT snapshots over the last {@link SNAPSHOT_SPAN_DAYS} days, 0.5 BTC each. */
function buildSnapshotVos(nowMs) {
  const vos = [];
  for (let i = SNAPSHOT_SPAN_DAYS; i >= 1; i--) {
    const updateTime = nowMs - i * DAY_MS;
    vos.push({
      updateTime,
      data: { balances: [{ asset: "BTC", free: "0.5", locked: "0" }] },
    });
  }
  return vos;
}

/** One [ms, price] point per day across (and just past) the snapshot span, at the
 *  flat BTC price — so every month-end date in the curve has a price to value. */
function buildHistoryPrices(nowMs) {
  const prices = [];
  for (let i = SNAPSHOT_SPAN_DAYS + 5; i >= 0; i--) {
    prices.push([nowMs - i * DAY_MS, HISTORY_PRICE_EUR]);
  }
  return prices;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const nowMs = Date.now();

  // Log every request to stderr (Playwright pipes it). The history backfill is
  // best-effort and swallows errors, so without this a fake/endpoint mismatch would
  // surface only as an opaque "Datos desde" assertion failure with no clue why.
  if (path !== "/__health") {
    console.error(`fake-binance-server: ${req.method} ${path}`);
  }

  const json = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Readiness probe for Playwright's webServer.
  if (path === "/__health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // ── Binance ────────────────────────────────────────────────────────────────
  if (path === "/api/v3/account") {
    // SPOT balances → 0.5 BTC on the market rung.
    json({ balances: [{ asset: "BTC", free: "0.5", locked: "0" }] });
    return;
  }
  if (path === "/sapi/v1/asset/get-funding-asset") {
    json([]); // no funding-wallet balances
    return;
  }
  if (path === "/sapi/v1/simple-earn/flexible/position") {
    json({ rows: [], total: 0 }); // no flexible Earn
    return;
  }
  if (path === "/sapi/v1/simple-earn/locked/position") {
    // LOCKED Earn → 3 ETH on the term-locked rung (its own holding).
    json({ rows: [{ asset: "ETH", amount: "3" }], total: 1 });
    return;
  }
  if (path === "/sapi/v1/accountSnapshot") {
    json({ snapshotVos: buildSnapshotVos(nowMs) });
    return;
  }

  // ── CoinGecko (prefixed /coingecko/api/v3) ──────────────────────────────────
  if (path === "/coingecko/api/v3/simple/price") {
    const id = (url.searchParams.get("ids") ?? "").toLowerCase();
    const eur = LIVE_PRICES_EUR[id];
    json(eur === undefined ? {} : { [id]: { eur } });
    return;
  }
  if (/^\/coingecko\/api\/v3\/coins\/[^/]+\/market_chart\/range$/.test(path)) {
    json({ prices: buildHistoryPrices(nowMs) });
    return;
  }

  // A missed handler is the most likely cause of a silent backfill failure — make
  // it impossible to miss in the Playwright output.
  console.error(`fake-binance-server: NO HANDLER for ${req.method} ${path}`);
  res.writeHead(404, { "content-type": "text/plain" });
  res.end(`fake-binance-server: no handler for ${req.method} ${path}`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake-binance-server listening on http://127.0.0.1:${PORT}`);
});
