/**
 * Journey 31: Binance connected source, end to end (PRD #245 S7, #252, ADR 0021).
 *
 * Against a stubbed Binance + CoinGecko API (e2e/fake-binance-server.mjs, wired in
 * via WORTHLINE_BINANCE_BASE_URL / WORTHLINE_COINGECKO_BASE_URL — the connect/sync
 * fetches run server-side, which page.route() can't intercept): connect with dummy
 * read-only credentials → sync → see a MARKET holding and a TERM-LOCKED holding
 * with their live values → open the market holding's token-grouped detail → see the
 * monthly-history curve's "Datos desde DD/MM/YYYY" start marker.
 *
 * The fake serves a fixed account: 0.5 BTC spot (market) + 3 ETH locked Earn
 * (term-locked); BTC 50 000 € / ETH 2 000 € live → 25 000 € market + 6 000 €
 * term-locked; daily SPOT snapshots over ~70 days at 40 000 €/BTC → a real history
 * start date.
 */

import { test, expect, openAdvancedSettings } from "./fixtures";

test("binance: connect (stubbed API) → market + term-locked holdings → token detail + history curve", async ({
  page,
}) => {
  // 1. Connect with dummy credentials (the fake server ignores the HMAC signature).
  await page.goto("/ajustes");
  await page.getByLabel("Clave de API de Binance").fill("e2e-key");
  await page.getByLabel("Secreto de API de Binance").fill("e2e-secret");
  await page.getByRole("button", { name: "Conectar Binance" }).click();
  await expect(page.getByRole("status")).toHaveText("Cuenta de Binance conectada.");

  // 2. Sync: pulls spot (market) + locked Earn (term-locked) balances, resolves live
  //    EUR prices, and backfills the monthly history — all from the fake server.
  await page.getByRole("button", { name: "Sincronizar Binance" }).click();
  await expect(page.getByRole("status")).toHaveText("Cuenta de Binance sincronizada.");

  // 3. Both holdings appear in the unified list with their live values: the market
  //    holding (0.5 BTC × 50 000 = 25 000 €) and the SEPARATE term-locked one
  //    (3 ETH × 2 000 = 6 000 €), tagged "(bloqueado)".
  await page.goto("/patrimonio");
  const marketRow = page
    .locator(".balanceRow")
    .filter({ has: page.getByRole("link", { name: "Binance", exact: true }) });
  await expect(marketRow).toContainText(/25\.000/);
  const lockedRow = page.locator(".balanceRow").filter({
    has: page.getByRole("link", { name: "Binance (bloqueado)", exact: true }),
  });
  // es-ES omits the thousands separator below 10 000, so 6 000 renders "6000 €".
  await expect(lockedRow).toContainText(/6000/);

  // 4. The market holding's detail is the read-only connected-source surface: tokens
  //    grouped by symbol (BTC) + the history curve's "Datos desde" start marker.
  await page.getByRole("link", { name: "Binance", exact: true }).click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await openAdvancedSettings(page);
  const detail = page.getByRole("region", { name: "Cuenta Binance" });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Conectado");
  await expect(detail).toContainText("BTC");
  await expect(detail).toContainText(/25\.000/);
  await expect(detail).toContainText(/Datos desde \d{2}\/\d{2}\/\d{4}/);

  // 5. The term-locked holding's detail shows its ETH token (the other rung).
  await page.goto("/patrimonio");
  await page.getByRole("link", { name: "Binance (bloqueado)", exact: true }).click();
  await expect(page).toHaveURL(/\/patrimonio\/.+\/editar/);
  await openAdvancedSettings(page);
  await expect(page.getByRole("region", { name: "Cuenta Binance" })).toContainText("ETH");

  // 6. The dashboard renders, populated, with no hydration/console errors (fixture).
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();
});
