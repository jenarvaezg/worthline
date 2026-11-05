/**
 * Fake transports for the MyInvestor client tests (#1877). Nothing here reaches the
 * network: `fixtureTransport` answers from the S1 fixtures (#1887) by the request each
 * manifest entry records, and `scriptedTransport` plays a fixed list of outcomes.
 */
import {
  MYINVESTOR_FIXTURES,
  readMyInvestorFixtureText,
} from "@pricing/__fixtures__/myinvestor";

import type { FixtureManifestEntry } from "@pricing/myinvestor/fixtures/capture-plan";
import { MYINVESTOR_PATHS } from "@pricing/myinvestor/protocol";
import type {
  MyInvestorRequest,
  MyInvestorTransport,
  TransportOutcome,
} from "@pricing/myinvestor/transport";

const BROKER_ORDERS_PATH = MYINVESTOR_PATHS.brokerOrders;

export interface RecordingTransport extends MyInvestorTransport {
  readonly requests: MyInvestorRequest[];
}

/** A response as the relay hands it back. */
export function reply(
  status: number,
  body = "",
  options: { contentType?: string; relayError?: string } = {},
): TransportOutcome {
  return {
    kind: "response",
    status,
    contentType: options.contentType ?? "application/json",
    text: body,
    relayError: options.relayError ?? null,
  };
}

/** A fixture body as a 2xx response. */
export function fixtureReply(file: string, status = 200): TransportOutcome {
  return reply(status, readMyInvestorFixtureText(file));
}

/** Plays `script` in order, one outcome per request; runs out loudly. */
export function scriptedTransport(
  script: readonly TransportOutcome[],
): RecordingTransport {
  const requests: MyInvestorRequest[] = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      const next = script[requests.length - 1];
      if (!next) throw new Error(`Petición de más: ${request.method} ${request.path}`);
      return next;
    },
  };
}

function sameQuery(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

/**
 * Answers every GET with the fixture whose manifest entry records that exact request.
 * `prefer` puts some fixtures first — a synthetic account that answers the same
 * request as a captured one (the robo-advisor of #1883 answers the account lists).
 */
export function fixtureTransport(
  options: { prefer?: (file: string) => boolean } = {},
): RecordingTransport {
  const requests: MyInvestorRequest[] = [];
  const prefer = options.prefer;
  const fixtures = prefer
    ? [
        ...MYINVESTOR_FIXTURES.filter(
          (entry) => entry.file !== null && prefer(entry.file),
        ),
        ...MYINVESTOR_FIXTURES,
      ]
    : MYINVESTOR_FIXTURES;
  return {
    requests,
    async send(request) {
      requests.push(request);
      const entry = fixtures.find(
        (candidate) =>
          candidate.file !== null &&
          candidate.method === request.method &&
          candidate.path === request.path &&
          sameQuery(candidate.query, request.query ?? {}),
      );
      if (entry?.file) return fixtureReply(entry.file, entry.status);
      const window = brokerWindowReply(fixtures, request);
      if (window) return window;
      throw new Error(`Sin fixture para ${request.method} ${request.path}`);
    },
  };
}

/**
 * The broker's list for a window of days, as MyInvestor answers it: the captured
 * full-history list of that account, keeping the orders whose day falls inside the
 * window. The adapter asks it one calendar year at a time.
 */
function brokerWindowReply(
  fixtures: readonly FixtureManifestEntry[],
  request: MyInvestorRequest,
): TransportOutcome | null {
  const query = request.query ?? {};
  if (request.path !== BROKER_ORDERS_PATH || !query.dateFrom || !query.dateTo) {
    return null;
  }
  const full = fixtures.find(
    (candidate) =>
      candidate.file !== null &&
      candidate.path === BROKER_ORDERS_PATH &&
      candidate.query.stockAccountId === query.stockAccountId &&
      candidate.query.type === query.type,
  );
  if (!full?.file) return null;
  const body = JSON.parse(readMyInvestorFixtureText(full.file)) as {
    payload: { data: { orderDate?: string | null }[] };
  };
  const inside = body.payload.data.filter((order) => {
    const day = order.orderDate?.slice(0, 10);
    return day !== undefined && day >= query.dateFrom! && day <= query.dateTo!;
  });
  return reply(
    full.status,
    JSON.stringify({ ...body, payload: { ...body.payload, data: inside } }),
  );
}

/** A `sleep` that records the waits instead of waiting. */
export function recordingSleep(): {
  waits: number[];
  sleep: (ms: number) => Promise<void>;
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}
