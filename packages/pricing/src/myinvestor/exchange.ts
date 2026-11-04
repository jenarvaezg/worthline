/**
 * One call to MyInvestor through the transport, with the part of the error map that
 * does not depend on the endpoint: the relay's own refusals, and network or WAF
 * failures retried with growing waits inside the same call (ADR 0114, decision 7).
 * What a 4xx means is the endpoint's to say (`session.ts`, `reader.ts`).
 */
import {
  fail,
  type MyInvestorError,
  type MyInvestorResult,
  type MyInvestorStep,
  safeCode,
  succeed,
} from "./errors";
import { parseMyInvestorJson } from "./json";
import type {
  MyInvestorRequest,
  MyInvestorTransport,
  TransportOutcome,
} from "./transport";

/** Three retries, each wait twice the last (2 s, 4 s, 8 s): 14 s at most per call. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000];

export interface ExchangeContext {
  readonly transport: MyInvestorTransport;
  readonly sleep: (ms: number) => Promise<void>;
  /** One wait per retry; its length is the number of retries. */
  readonly retryDelaysMs: readonly number[];
}

/** MyInvestor's answer, its body parsed with the numbers kept as written. */
export interface Answer {
  readonly status: number;
  /** `undefined` for an empty body; {@link NOT_JSON} when the body is not JSON. */
  readonly body: unknown;
  readonly attempts: number;
}

export const NOT_JSON: unique symbol = Symbol("not-json");

const RELAY_CODE = /^[a-z][a-z0-9_]{0,39}$/;
const WAF_MARKER = "_Incapsula_Resource";

type Classified =
  | { readonly kind: "answer"; readonly status: number; readonly text: string }
  | { readonly kind: "transient"; readonly status: number | null; readonly code: string }
  | { readonly kind: "relay"; readonly status: number; readonly code: string | null };

function classify(outcome: TransportOutcome): Classified {
  if (outcome.kind === "unreachable") {
    return { kind: "transient", status: null, code: outcome.reason };
  }
  const { status, contentType, text, relayError } = outcome;
  if (relayError !== null) {
    const code = RELAY_CODE.test(relayError) ? relayError : null;
    return code === "upstream_unreachable"
      ? { kind: "transient", status, code }
      : { kind: "relay", status, code };
  }
  if (contentType.includes("text/html") || text.slice(0, 2_000).includes(WAF_MARKER)) {
    return { kind: "transient", status, code: "waf" };
  }
  if (status >= 500) return { kind: "transient", status, code: "server_error" };
  if (status === 429) return { kind: "transient", status, code: "rate_limited" };
  if (status === 408) return { kind: "transient", status, code: "timeout" };
  return { kind: "answer", status, text };
}

function parse(text: string): unknown {
  try {
    return parseMyInvestorJson(text);
  } catch {
    return NOT_JSON;
  }
}

export interface ExchangeOptions {
  /** False for calls that must never repeat themselves, like sending the SMS. */
  readonly retry: boolean;
}

export async function exchange(
  context: ExchangeContext,
  request: MyInvestorRequest,
  step: MyInvestorStep,
  options: ExchangeOptions = { retry: true },
): Promise<MyInvestorResult<Answer>> {
  const delays = options.retry ? context.retryDelaysMs : [];
  for (let attempt = 1; ; attempt += 1) {
    const outcome = classify(await context.transport.send(request));
    if (outcome.kind === "answer") {
      return succeed({
        status: outcome.status,
        body: parse(outcome.text),
        attempts: attempt,
      });
    }
    if (outcome.kind === "relay") {
      return fail({
        kind: "relay_rejected",
        step,
        httpStatus: outcome.status,
        code: outcome.code,
        attempts: attempt,
      });
    }
    const wait = delays[attempt - 1];
    if (wait === undefined) {
      return fail({
        kind: "network_or_waf",
        step,
        httpStatus: outcome.status,
        code: outcome.code,
        attempts: attempt,
      });
    }
    await context.sleep(wait);
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** `payload.data` of MyInvestor's envelope. */
export function envelopeData(body: unknown): unknown {
  return field(field(body, "payload"), "data");
}

/** The most specific error code of a body: `payload.data.errCode`, then `status.code`, then `code`. */
export function errorCode(body: unknown): string | null {
  return (
    safeCode(field(envelopeData(body), "errCode")) ??
    safeCode(field(field(body, "status"), "code")) ??
    safeCode(field(body, "code"))
  );
}

/** An error built from an answer the endpoint did not expect. */
export function answerError(
  kind: MyInvestorError["kind"],
  step: MyInvestorStep,
  answer: Answer,
  code: string | null = errorCode(answer.body),
): MyInvestorError {
  return { kind, step, httpStatus: answer.status, code, attempts: answer.attempts };
}
