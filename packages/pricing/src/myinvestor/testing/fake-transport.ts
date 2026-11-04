/**
 * Fake transports for the MyInvestor client tests (#1877). Nothing here reaches the
 * network: `fixtureTransport` answers from the S1 fixtures (#1887) by the request each
 * manifest entry records, and `scriptedTransport` plays a fixed list of outcomes.
 */
import {
  MYINVESTOR_FIXTURES,
  readMyInvestorFixtureText,
} from "@pricing/__fixtures__/myinvestor";

import type {
  MyInvestorRequest,
  MyInvestorTransport,
  TransportOutcome,
} from "@pricing/myinvestor/transport";

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

/** Answers every GET with the fixture whose manifest entry records that exact request. */
export function fixtureTransport(): RecordingTransport {
  const requests: MyInvestorRequest[] = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      const entry = MYINVESTOR_FIXTURES.find(
        (candidate) =>
          candidate.file !== null &&
          candidate.method === request.method &&
          candidate.path === request.path &&
          sameQuery(candidate.query, request.query ?? {}),
      );
      if (!entry?.file) {
        throw new Error(`Sin fixture para ${request.method} ${request.path}`);
      }
      return fixtureReply(entry.file, entry.status);
    },
  };
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
