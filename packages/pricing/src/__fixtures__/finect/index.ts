import { readFileSync } from "node:fs";

/**
 * Real Finect sheets, captured verbatim (see `README.md`). Read once at module
 * load: every Finect test parses the same three pages.
 */
const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

export const FUND_USD_HTML = read("fund-usd.html");
export const PENSION_PLAN_EUR_HTML = read("pension-plan-eur.html");
export const PRODUCTO_NO_DISPONIBLE_HTML = read("producto-no-disponible.html");
