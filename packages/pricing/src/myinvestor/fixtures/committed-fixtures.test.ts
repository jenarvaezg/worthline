/**
 * The guards on the COMMITTED MyInvestor fixtures (#1887). They run in CI, where the raw
 * captures are not: the leak check against the raw side runs locally (see the skill
 * `.claude/skills/myinvestor-fixtures/`). Here:
 * - no file holds an IBAN or a DNI/NIE whose control digits verify (the fakes always
 *   break them, so a valid one can only be real);
 * - the manifests and the files agree;
 * - P8 of #1869 holds on the fixtures: today's shares of every plan, fund and stock
 *   rebuild EXACTLY from the COMPLETE orders, so the invented figures kept the books;
 * - what a cash account holds back is exactly what its orders in progress block.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MYINVESTOR_FIXTURES,
  MYINVESTOR_FIXTURES_DIR,
  readMyInvestorFixtureText,
} from "@pricing/__fixtures__/myinvestor";
import { describe, expect, it } from "vitest";

import { addDecimals, canonicalDecimal } from "./decimal";
import { findValidIdentities } from "./identity-checks";
import {
  isPlainObject,
  JsonNumber,
  type LiteralJson,
  parseWithLiterals,
} from "./json-literals";

const DIR = fileURLToPath(MYINVESTOR_FIXTURES_DIR);
const allFiles = () =>
  readdirSync(DIR, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.includes("."),
  );

type Row = { [key: string]: LiteralJson };

function rows(file: string): Row[] {
  const body = parseWithLiterals(readMyInvestorFixtureText(file));
  const data =
    isPlainObject(body) && isPlainObject(body.payload ?? null) ? body.payload : null;
  const list = data && isPlainObject(data) ? data.data : null;
  if (Array.isArray(list)) return list.filter(isPlainObject);
  if (list && isPlainObject(list)) return [list];
  throw new Error(`${file}: sin payload.data`);
}

const text = (value: LiteralJson | undefined) => (typeof value === "string" ? value : "");
const literal = (value: LiteralJson | undefined) => {
  if (!(value instanceof JsonNumber)) throw new Error("se esperaba un número");
  return value.source;
};

/** The signed shares a COMPLETE order adds to its holding; throws on an unknown type. */
function signedShares(
  order: Row,
  inbound: readonly string[],
  outbound: readonly string[],
) {
  const type = text(order.operationType);
  const shares = canonicalDecimal(literal(order.shares));
  if (inbound.includes(type)) return shares;
  if (outbound.includes(type))
    return shares.startsWith("-") ? shares.slice(1) : `-${shares}`;
  throw new Error(`Tipo de orden sin signo conocido: ${type}`);
}

function netByInstrument(
  orders: readonly Row[],
  key: string,
  inbound: readonly string[],
  outbound: readonly string[],
): Map<string, string> {
  const parts = new Map<string, string[]>();
  for (const order of orders) {
    if (text(order.status) !== "COMPLETE") continue;
    const id = text(order[key]);
    parts.set(id, [...(parts.get(id) ?? []), signedShares(order, inbound, outbound)]);
  }
  return new Map([...parts].map(([id, values]) => [id, addDecimals(values)]));
}

/** Today's shares of a securities account, by ISIN, for the items `take` accepts. */
function holdings(account: string, take: (productTypeCode: string) => boolean) {
  const [detail] = rows(account);
  const groups =
    detail && isPlainObject(detail.securitiesAccountInvestments ?? null)
      ? Object.values(detail.securitiesAccountInvestments as Row)
      : [];
  const held = new Map<string, string>();
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.investmentList)) continue;
    for (const item of group.investmentList.filter(isPlainObject)) {
      if (!take(text(item.productTypeCode))) continue;
      held.set(text(item.isin), canonicalDecimal(literal(item.shares)));
    }
  }
  return held;
}

/** The fixture with a body for a request (a 401 with no body shares the path). */
const entryAt = (origin: string, path: string) =>
  MYINVESTOR_FIXTURES.find(
    (entry) => entry.origin === origin && entry.path === path && entry.file !== null,
  );

/** `accountId → cashAccountId` from an account list of one origin. */
function cashAccountsOf(origin: string, path: string): Map<string, string> {
  const list = entryAt(origin, path);
  if (!list?.file) return new Map();
  return new Map(
    rows(list.file).map((row) => [text(row.accountId), text(row.cashAccountId)]),
  );
}

function pairs(kind: "pension-accounts" | "securities-accounts") {
  const version = kind === "pension-accounts" ? "v2" : "v3";
  const orders = new RegExp(`^/cperf-server/api/${version}/${kind}/(\\d+)/orders$`);
  return MYINVESTOR_FIXTURES.flatMap((entry) => {
    const id = orders.exec(entry.path)?.[1];
    if (!id || !entry.file) return [];
    const account = MYINVESTOR_FIXTURES.find(
      (other) =>
        other.origin === entry.origin &&
        other.path === `/cperf-server/api/v2/${kind}/${id}`,
    );
    return account?.file ? [{ orders: entry.file, account: account.file }] : [];
  });
}

describe("committed MyInvestor fixtures", () => {
  it("hold no IBAN and no DNI/NIE whose control digits verify", () => {
    const hits = allFiles().flatMap((name) =>
      findValidIdentities(readFileSync(`${DIR}/${name}`, "utf8")).map(
        (hit) => `${name}: ${hit.kind}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it("list every body in a manifest, and every manifest file exists", () => {
    const bodies = allFiles().filter(
      (name) => name.endsWith(".json") && !name.endsWith("manifest.json"),
    );
    const listed = new Set(
      MYINVESTOR_FIXTURES.flatMap((entry) => (entry.file ? [entry.file] : [])),
    );
    expect([...listed].sort()).toEqual(bodies.sort());
  });

  it("rebuild today's shares of every plan exactly from its COMPLETE orders (P8)", () => {
    const found = pairs("pension-accounts");
    expect(found.length).toBeGreaterThan(0);
    for (const { orders, account } of found) {
      const net = netByInstrument(
        rows(orders),
        "dgsCode",
        [
          "PLAN_CONTRIBUTION",
          "REGISTRATION_BY_INTERNAL_PLAN_TRANSFER",
          "REGISTRATION_BY_EXTERNAL_PLAN_TRANSFER",
        ],
        ["DEREGISTRATION_BY_INTERNAL_PLAN_TRANSFER"],
      );
      const held = new Map(
        rows(account).map((plan) => [
          text(plan.dgsCode),
          canonicalDecimal(literal(plan.shares)),
        ]),
      );
      for (const [dgs, shares] of net)
        expect([orders, dgs, shares]).toEqual([orders, dgs, held.get(dgs) ?? "0"]);
      for (const [dgs, shares] of held)
        expect([account, dgs, net.get(dgs) ?? "0"]).toEqual([account, dgs, shares]);
    }
  });

  it("rebuild today's shares of every fund exactly from its COMPLETE orders (P8)", () => {
    const found = pairs("securities-accounts");
    expect(found.length).toBeGreaterThan(0);
    for (const { orders, account } of found) {
      const net = netByInstrument(
        rows(orders).filter((order) => text(order.productType) === "IIC"),
        "isin",
        [
          "INVESTMENT_FUNDS_SUBSCRIPTION",
          "IIC_SWITCH_REGISTRATION",
          "INTERNAL_TRANSFER_SUBSCRIPTION",
        ],
        [
          "INVESTMENT_FUNDS_REIMBURSEMENT",
          "IIC_SWITCH_DEREGISTRATION",
          "INTERNAL_TRANSFER_REIMBURSEMENT",
        ],
      );
      // Stocks, ETF and ETC are not in this endpoint: their orders live in the broker's.
      const held = holdings(account, (code) => code === "IIC");
      for (const [isin, shares] of net)
        expect([orders, isin, shares]).toEqual([orders, isin, held.get(isin) ?? "0"]);
      for (const [isin, shares] of held)
        expect([account, isin, net.get(isin) ?? "0"]).toEqual([account, isin, shares]);
    }
  });

  it("rebuild today's shares of every stock, ETF and ETC from the broker's orders (P8)", () => {
    const listings = MYINVESTOR_FIXTURES.filter(
      (entry) => entry.path === "/broker/v2/stock-orders" && entry.file,
    );
    let checked = 0;
    for (const listing of listings) {
      const accountId = listing.query.stockAccountId ?? "";
      const account = entryAt(
        listing.origin,
        `/cperf-server/api/v2/securities-accounts/${accountId}`,
      );
      if (!listing.file || !account?.file) continue;
      const parts = new Map<string, string[]>();
      for (const order of rows(listing.file)) {
        const detail = entryAt(
          listing.origin,
          `/broker/v2/stock-orders/${text(order.id)}`,
        );
        if (!detail?.file)
          throw new Error(`${listing.file}: falta el detalle de una orden`);
        const [execution] = rows(detail.file);
        if (!execution || text(execution.orderStatus) !== "COMPLETE") continue;
        const shares = canonicalDecimal(literal(execution.executedShares));
        const side = text(execution.orderOperationTypeEnum);
        if (side !== "BUY" && side !== "SELL")
          throw new Error(`Lado desconocido: ${side}`);
        const isin = text(execution.instrumentIsin);
        parts.set(isin, [
          ...(parts.get(isin) ?? []),
          side === "BUY" ? shares : `-${shares}`,
        ]);
      }
      const net = new Map(
        [...parts].map(([isin, values]) => [isin, addDecimals(values)]),
      );
      const held = holdings(account.file, (code) => code !== "IIC");
      for (const [isin, shares] of net) {
        if (shares !== "0" || held.has(isin)) {
          expect([listing.file, isin, shares]).toEqual([
            listing.file,
            isin,
            held.get(isin),
          ]);
        }
      }
      for (const [isin, shares] of held)
        expect([account.file, isin, net.get(isin) ?? "0"]).toEqual([
          account.file,
          isin,
          shares,
        ]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("hold back in each cash account exactly what its orders in progress block", () => {
    let checked = 0;
    for (const origin of ["capture", "synthetic"] as const) {
      const cashList = entryAt(origin, "/cperf-server/api/v2/cash-accounts/self");
      if (!cashList?.file) continue;
      const owners = [
        ...cashAccountsOf(origin, "/cperf-server/api/v2/pension-accounts/self"),
        ...cashAccountsOf(origin, "/cperf-server/api/v2/securities-accounts/self-basic"),
      ];
      const blocked = new Map<string, string[]>();
      for (const [accountId, cashAccountId] of owners) {
        const orders = MYINVESTOR_FIXTURES.find(
          (entry) =>
            entry.origin === origin &&
            new RegExp(`/(pension|securities)-accounts/${accountId}/orders$`).test(
              entry.path,
            ),
        );
        if (!orders?.file) continue;
        for (const order of rows(orders.file)) {
          if (text(order.status) !== "IN_PROGRESS") continue;
          const amounts = blocked.get(cashAccountId) ?? [];
          blocked.set(cashAccountId, [
            ...amounts,
            canonicalDecimal(literal(order.amountToBlock)),
          ]);
        }
      }
      for (const cash of rows(cashList.file)) {
        const withheld = canonicalDecimal(literal(cash.withheldBalance));
        const sum = addDecimals(blocked.get(text(cash.accountId)) ?? []);
        expect([cashList.file, text(cash.accountId), withheld]).toEqual([
          cashList.file,
          text(cash.accountId),
          sum,
        ]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
