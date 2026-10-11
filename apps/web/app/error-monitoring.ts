import type { ErrorEvent, NodeOptions } from "@sentry/nextjs";

/** One SDK integration, as `NodeOptions.integrations` hands them to a filter. */
export type SentryIntegration = Extract<
  NonNullable<NodeOptions["integrations"]>,
  readonly unknown[]
>[number];

/** What `beforeSend` receives as its second argument. */
type EventHint = Parameters<NonNullable<NodeOptions["beforeSend"]>>[1];

/**
 * Error monitoring with Sentry (#1175, PRD #1171 S4; ADR 0110) — the policy
 * half, pure.
 *
 * The privacy policy declares Sentry as an encargado that receives the TYPE of a
 * server error, where in the code it broke and on which screen — never the text
 * of the error, nor anything about the person or their workspace — and the
 * no-telemetry constraint (#1131, CONTEXT.md) says nothing else leaves: no
 * tracing, no replay, no sessions, no analytics. This module IS that promise in
 * code, and its tests are the sentence. Three layers, each sufficient on its own
 * for what it covers:
 *
 *  1. **Nothing is collected** — `dataCollection` off across the board (v11 of
 *     the SDK collects EVERYTHING when it is left unset), no breadcrumbs, no
 *     local variables, no source lines, no server name.
 *  2. **Only error capture runs** — an ALLOWLIST of integrations, so whatever a
 *     future SDK version adds by default (sessions, request data, console
 *     capture, outgoing-request instrumentation) stays off without anyone
 *     noticing it shipped. No `tracesSampleRate` (defining it, even as 0, turns
 *     the tracing machinery on), no OpenTelemetry setup, no transactions, no
 *     Spotlight sidecar.
 *  3. **`beforeSend` rebuilds the event from an allowlist, with NO free text** —
 *     the error's class, the code location, the route PATTERN and the runtime.
 *     The message is replaced by a marker: an error message is the one field
 *     where interpolated user input (a holding's label, a typed figure) can ride
 *     along, and no redaction rule can promise to catch all of it. What makes
 *     the event still worth having is the React `digest` Next.js attaches to a
 *     render error: the marker carries it, and the same digest sits next to the
 *     full error in the deploy's runtime logs (Vercel, already an encargado).
 *     Sentry says THAT something broke, where and how often; the logs say what.
 *
 * Server-side only, by decision: the browser bundle loads no Sentry. The
 * enforced CSP keeps `connect-src 'self'` precisely because no client code
 * talks to a third party (`security-headers.ts`), and a browser SDK would
 * either break that or need a tunnel route through the auth proxy — plus ship
 * an SDK to every page. Server errors (RSC renders, route handlers, server
 * actions, the proxy) are what `onRequestError` reports.
 *
 * No DSN, no monitoring: nothing is initialized, nothing is imported.
 */

/** The env var holding the project's DSN. Server-only — never `NEXT_PUBLIC_`. */
export const ERROR_MONITORING_DSN_ENV = "SENTRY_DSN";

/** The DSN, or null when unset/blank — then Sentry is never initialized. */
export function errorMonitoringDsn(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const dsn = env[ERROR_MONITORING_DSN_ENV]?.trim();
  return dsn ? dsn : null;
}

/**
 * The integrations that capture errors and nothing else; `Context` adds the
 * runtime/OS the scrubber keeps. Frame-rewriting integrations are deliberately
 * absent: they only matter once source maps are uploaded, which this app does
 * not do yet (ADR 0110) — add them with the upload, not before.
 */
const KEPT_INTEGRATIONS: ReadonlySet<string> = new Set([
  "Context",
  "Dedupe",
  "EventFilters",
  "FunctionToString",
  "LinkedErrors",
  "OnUncaughtException",
  "OnUnhandledRejection",
]);

export function errorMonitoringOptions(dsn: string): NodeOptions {
  return {
    beforeBreadcrumb: () => null,
    beforeSend: (event, hint) => scrubErrorEvent(event, hint),
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    beforeSendTransaction: () => null,
    dataCollection: {
      cookies: false,
      databaseQueryData: false,
      frameContextLines: 0,
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
      httpBodies: [],
      httpHeaders: false,
      queues: false,
      stackFrameVariables: false,
      urlQueryParams: false,
      userInfo: false,
    },
    dsn,
    enableOpenTelemetrySetup: false,
    enhanceFetchErrorMessages: false,
    includeLocalVariables: false,
    includeServerName: false,
    integrations: (defaults: SentryIntegration[]) =>
      defaults.filter((integration) => KEPT_INTEGRATIONS.has(integration.name)),
    maxBreadcrumbs: 0,
    sendClientReports: false,
    // `false` wins over SENTRY_SPOTLIGHT; leaving it out would let the env var
    // turn the development sidecar on in a deployed process.
    spotlight: false,
    tracePropagationTargets: [],
  };
}

/** What replaces every free-text field of an event. */
export const OMITTED_ERROR_TEXT = "[texto del error omitido]";

/** A transaction worth keeping is a route pattern: `METHOD /path`, no query. */
const ROUTE_TRANSACTION = /^[A-Z]+ \/[^\s?#]*$/;

/**
 * The React digest Next.js stamps on a server render error — a hash, not the
 * message — the key that finds the full error in the runtime logs.
 */
function errorDigest(hint: EventHint | undefined): string | null {
  const original = hint?.originalException;
  if (original === null || typeof original !== "object" || !("digest" in original)) {
    return null;
  }
  const digest = (original as { digest?: unknown }).digest;
  return typeof digest === "string" && /^[\w-]{1,64}$/.test(digest) ? digest : null;
}

type StackFrame = NonNullable<
  NonNullable<NonNullable<ErrorEvent["exception"]>["values"]>[number]["stacktrace"]
>["frames"] extends Array<infer F> | undefined
  ? F
  : never;

/** Code location only: no `vars`, no source lines, no frame metadata. */
function scrubFrame(frame: StackFrame): StackFrame {
  const kept: StackFrame = {};
  if (frame.filename !== undefined) kept.filename = frame.filename;
  if (frame.abs_path !== undefined) kept.abs_path = frame.abs_path;
  if (frame.function !== undefined) kept.function = frame.function;
  if (frame.lineno !== undefined) kept.lineno = frame.lineno;
  if (frame.colno !== undefined) kept.colno = frame.colno;
  if (frame.in_app !== undefined) kept.in_app = frame.in_app;
  return kept;
}

function pick<T extends Record<string, unknown>>(
  source: T | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!source) return undefined;
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * The `beforeSend`: rebuild the event from an allowlist, with no free text. What
 * is copied is the shape of the failure — the error class, where in OUR code it
 * broke, which route pattern, which runtime — and what is not copied cannot
 * leak, whatever the SDK attached upstream.
 */
export function scrubErrorEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent {
  const digest = errorDigest(hint);
  const marker = digest ? `${OMITTED_ERROR_TEXT} · digest ${digest}` : OMITTED_ERROR_TEXT;

  const scrubbed: ErrorEvent = { type: undefined };
  if (event.event_id !== undefined) scrubbed.event_id = event.event_id;
  if (event.timestamp !== undefined) scrubbed.timestamp = event.timestamp;
  if (event.level !== undefined) scrubbed.level = event.level;
  if (event.platform !== undefined) scrubbed.platform = event.platform;
  if (event.environment !== undefined) scrubbed.environment = event.environment;
  if (event.release !== undefined) scrubbed.release = event.release;
  if (event.dist !== undefined) scrubbed.dist = event.dist;
  if (event.debug_meta !== undefined) scrubbed.debug_meta = event.debug_meta;
  const sdk = pick(event.sdk as Record<string, unknown> | undefined, ["name", "version"]);
  if (sdk) scrubbed.sdk = sdk as NonNullable<ErrorEvent["sdk"]>;
  // `captureRequestError` names it `METHOD /route/[pattern]`; anything else
  // (a concrete URL, a free-form name) is not copied.
  if (event.transaction !== undefined && ROUTE_TRANSACTION.test(event.transaction)) {
    scrubbed.transaction = event.transaction;
  }
  if (event.message !== undefined) scrubbed.message = marker;
  if (event.logentry !== undefined) scrubbed.logentry = { message: marker };

  if (event.exception?.values) {
    scrubbed.exception = {
      values: event.exception.values.map((value) => ({
        ...(value.type !== undefined ? { type: value.type } : {}),
        ...(value.value !== undefined ? { value: marker } : {}),
        ...(value.mechanism
          ? {
              mechanism: {
                type: value.mechanism.type,
                ...(value.mechanism.handled !== undefined
                  ? { handled: value.mechanism.handled }
                  : {}),
              },
            }
          : {}),
        ...(value.stacktrace?.frames
          ? { stacktrace: { frames: value.stacktrace.frames.map(scrubFrame) } }
          : {}),
      })),
    };
  }

  const contexts: NonNullable<ErrorEvent["contexts"]> = {};
  const runtime = pick(event.contexts?.runtime, ["name", "version"]);
  if (runtime) contexts.runtime = runtime;
  const os = pick(event.contexts?.os, ["name", "version"]);
  if (os) contexts.os = os;
  const trace = pick(event.contexts?.trace, ["trace_id", "span_id"]);
  if (trace) contexts.trace = trace as NonNullable<typeof contexts.trace>;
  // The route PATTERN and kind; never `request_path`, the concrete URL.
  const nextjs = pick(event.contexts?.["nextjs"], [
    "router_kind",
    "router_path",
    "route_type",
  ]);
  if (nextjs) contexts["nextjs"] = nextjs;
  if (Object.keys(contexts).length > 0) scrubbed.contexts = contexts;

  return scrubbed;
}
