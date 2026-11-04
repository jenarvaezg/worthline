/**
 * From the raw captures of `.local/myinvestor-raw/` (one `<endpoint>[-<id>].json` per call
 * of `myinvestor raw`) to the committed fixtures and their manifest (#1887).
 *
 * Two passes: `anonymize.ts` replaces every personal value file by file, then
 * `rebuild.ts` recalculates across files what the API derives (orders' shares,
 * positions, balances, series), so the fixture adds up.
 *
 * A fixture is named after its endpoint and the FAKE id, the same fake that appears
 * inside its body. The manifest says which request each body answers, so the client of
 * S2 (#1877) can mock `fetch` with the right path, query and status.
 */

import { MYINVESTOR_PATHS as PATHS } from "@pricing/myinvestor/protocol";
import { type AnonymizeOptions, anonymizeTree } from "./anonymize";
import { parseWithLiterals, stringifyWithLiterals } from "./json-literals";
import type { Pseudonymizer } from "./pseudonymizer";
import { type RebuildOptions, rebuildCaptures } from "./rebuild";

export interface FixtureManifestEntry {
  /** Relative to the fixtures folder; `null` when the response has no body worth keeping. */
  readonly file: string | null;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly status: number;
  /** `capture`: anonymized from a real response. `synthetic`: written by hand. */
  readonly origin: "capture" | "synthetic";
  readonly note: string | null;
}

export interface RawCapture {
  /** The file name without `.json`, as `capture.sh` writes it. */
  readonly name: string;
  readonly text: string;
}

export interface CapturePlan {
  /** Each fixture with the raw capture it comes from (`source`, never committed). */
  readonly fixtures: readonly {
    readonly file: string;
    readonly text: string;
    readonly source: string;
  }[];
  readonly manifest: readonly FixtureManifestEntry[];
  /** Kinds of raw capture the connector does not read, left out on purpose. */
  readonly skipped: readonly string[];
}

interface Request {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
}

/** The calls `capture.sh` makes once. */
const SINGLE: Readonly<Record<string, Request>> = {
  "automatic-contributions": { path: PATHS.automaticContributions },
  "cash-accounts": { path: PATHS.cashAccounts },
  "pension-accounts": { path: PATHS.pensionAccounts },
  portfolios: { path: PATHS.portfolios },
  "securities-accounts": { path: PATHS.securitiesAccounts },
};

interface PerId {
  /** How the id in the file name is faked: an account id, or a broker order reference. */
  readonly id: "digits" | "reference";
  /** The request, from the fake id and the capture day (`AAAA-MM-DD`). */
  readonly request: (id: string, day: string) => Request;
}

/** The calls `capture.sh` makes per account (or per broker order). */
const PER_ID: Readonly<Record<string, PerId>> = {
  "broker-order-detail": {
    id: "reference",
    request: (id) => ({ path: PATHS.brokerOrderDetail(id) }),
  },
  "broker-orders": {
    id: "digits",
    request: (id, day) => ({
      path: PATHS.brokerOrders,
      query: { stockAccountId: id, type: "ALL", dateFrom: "2000-01-01", dateTo: day },
    }),
  },
  "pension-account": {
    id: "digits",
    request: (id) => ({ path: PATHS.pensionAccount(id) }),
  },
  "pension-orders": {
    id: "digits",
    request: (id, day) => ({
      path: PATHS.pensionOrders(id),
      query: { dateFrom: "20000101", dateTo: day.replaceAll("-", "") },
    }),
  },
  "pension-positions": {
    id: "digits",
    request: (id) => ({
      path: PATHS.pensionPositions(id),
      query: { groupType: "SINCE_BEGINNING" },
    }),
  },
  "securities-account": {
    id: "digits",
    request: (id) => ({ path: PATHS.securitiesAccount(id) }),
  },
  "securities-orders": {
    id: "digits",
    request: (id, day) => ({
      path: PATHS.securitiesOrders(id),
      query: { dateFrom: "2000-01-01", dateTo: day },
    }),
  },
  "securities-positions": {
    id: "digits",
    request: (id) => ({
      path: PATHS.securitiesPositions(id),
      query: { groupType: "SINCE_BEGINNING" },
    }),
  },
  "securities-transfers-pending": {
    id: "digits",
    request: (id) => ({
      path: PATHS.pendingTransfers(id),
    }),
  },
};

/**
 * Captured for the leak check (their values count as secrets) but never committed, because
 * the connector does not read them:
 * - the customer profile and the day-by-day cash balance, the most personal of the set
 *   (cash enters as today's balance, P6 of #1869);
 * - the `SINCE_BEGINNING` series of the securities accounts: the connector rebuilds funds
 *   and stocks from their orders. The series of the plans (#1872) is kept, recalculated.
 * The rebuild still reads them: their real prices price a transfer that brings no cash.
 */
const SKIPPED = new Set(["cash-historical-balance", "customer", "securities-positions"]);
const kindOf = (name: string) => name.replace(/-\d+$/, "");

function captureDay(name: string, text: string): string {
  const timestamp = (JSON.parse(text) as { status?: { timestamp?: unknown } }).status
    ?.timestamp;
  if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(timestamp)) {
    throw new Error(`${name}: la captura no trae status.timestamp`);
  }
  return timestamp.slice(0, 10);
}

function fakeName(capture: RawCapture, pseudonyms: Pseudonymizer) {
  const single = SINGLE[capture.name];
  if (single) return { base: capture.name, request: single };
  const match = /^(.+)-(\d+)$/.exec(capture.name);
  const kind = match ? PER_ID[match[1] ?? ""] : undefined;
  if (!match || !kind) throw new Error(`Captura desconocida: ${capture.name}`);
  const realId = match[2] ?? "";
  const fakeId =
    kind.id === "reference" ? pseudonyms.reference(realId) : pseudonyms.digits(realId);
  return {
    base: `${match[1]}-${fakeId}`,
    request: kind.request(fakeId, captureDay(capture.name, capture.text)),
  };
}

export function planCaptureFixtures(
  raw: readonly RawCapture[],
  options: AnonymizeOptions & RebuildOptions,
): CapturePlan {
  const sorted = [...raw]
    .filter((capture) => !SKIPPED.has(capture.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const skipped = [
    ...new Set(raw.map((c) => kindOf(c.name)).filter((k) => SKIPPED.has(k))),
  ];

  const trees = sorted.map((capture) => {
    const tree = parseWithLiterals(capture.text);
    return {
      name: capture.name,
      raw: tree,
      fake: anonymizeTree(tree, options),
      ...fakeName(capture, options.pseudonyms),
    };
  });
  rebuildCaptures(trees, options);

  const kept = trees.filter((tree) => !SKIPPED.has(kindOf(tree.name)));
  const fixtures = kept.map((tree) => ({
    file: `capture/${tree.base}.json`,
    text: stringifyWithLiterals(tree.fake),
    source: tree.name,
  }));
  const manifest: FixtureManifestEntry[] = kept.map((tree) => ({
    file: `capture/${tree.base}.json`,
    method: "GET",
    path: tree.request.path,
    query: tree.request.query ?? {},
    status: 200,
    origin: "capture",
    note: null,
  }));
  const byFile = (a: { file: string | null }, b: { file: string | null }) =>
    (a.file ?? "").localeCompare(b.file ?? "");
  return {
    fixtures: fixtures.sort(byFile),
    manifest: manifest.sort(byFile),
    skipped: skipped.sort(),
  };
}
