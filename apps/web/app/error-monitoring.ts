import type { ErrorEvent, NodeOptions } from "@sentry/nextjs";

/** One SDK integration, as `NodeOptions.integrations` hands them to a filter. */
export type SentryIntegration = Extract<
  NonNullable<NodeOptions["integrations"]>,
  readonly unknown[]
>[number];

/**
 * Error monitoring with Sentry (#1175, PRD #1171 S4) — the policy half, pure.
 *
 * The privacy policy declares Sentry as an encargado that receives «errores
 * técnicos, con los datos personales filtrados antes de enviarse», and the
 * no-telemetry promise of #1131 says nothing else leaves: no tracing, no replay,
 * no sessions, no analytics. This module IS that promise in code, and its tests
 * are the sentence. Three layers, each sufficient on its own for what it covers:
 *
 *  1. **Nothing is collected** — `dataCollection` off across the board (v11 of
 *     the SDK collects EVERYTHING when it is left unset), no breadcrumbs, no
 *     local variables, no source lines, no server name.
 *  2. **Only error capture runs** — an ALLOWLIST of integrations, so whatever a
 *     future SDK version adds by default (sessions, request data, console
 *     capture, outgoing-request instrumentation) stays off without anyone
 *     noticing it shipped. No `tracesSampleRate`: defining it, even as 0, turns
 *     the tracing machinery on.
 *  3. **`beforeSend` rebuilds the event from an allowlist** — the error's type,
 *     a redacted message, the code location and the route PATTERN. Anything the
 *     SDK or a future version attaches (user, request, cookies, extra, tags) is
 *     simply never copied over.
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
 * The integrations that capture errors and nothing else. `Context` adds the
 * runtime/OS the scrubber keeps; `DistDirRewriteFrames` (added by the Next.js
 * SDK only when its build plugin ran) normalizes frame paths.
 */
const KEPT_INTEGRATIONS: ReadonlySet<string> = new Set([
  "Context",
  "Dedupe",
  "DistDirRewriteFrames",
  "EventFilters",
  "FunctionToString",
  "LinkedErrors",
  "OnUncaughtException",
  "OnUnhandledRejection",
]);

export function errorMonitoringOptions(dsn: string): NodeOptions {
  return {
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubErrorEvent(event),
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
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
    enhanceFetchErrorMessages: false,
    includeLocalVariables: false,
    includeServerName: false,
    integrations: (defaults: SentryIntegration[]) =>
      defaults.filter((integration) => KEPT_INTEGRATIONS.has(integration.name)),
    maxBreadcrumbs: 0,
    sendClientReports: false,
    tracePropagationTargets: [],
  };
}

/**
 * Patterns that can carry a person or their workspace inside an error message,
 * applied in order. Quoted spans go wholesale: that is where interpolated user
 * input lands (a holding's label, a typed amount), and a code identifier lost
 * to it costs less than a label kept.
 */
const REDACTIONS: ReadonlyArray<[RegExp, string | ((...groups: string[]) => string)]> = [
  // URLs: keep scheme + host + path; drop credentials, query and fragment.
  [
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@"'`«»<>]+@)?([^\s?#"'`«»<>]*)([?#][^\s"'`«»<>]*)?/gi,
    (_match, scheme, credentials, rest, query) =>
      `${scheme}${credentials ? "[credentials]@" : ""}${rest}${query ? "?[redacted]" : ""}`,
  ],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]"],
  [/\bBearer\s+\S+/gi, "Bearer [token]"],
  [
    /\b(token|secret|password|passwd|authToken|apiKey|api_key|access_token|key)\s*[=:]\s*[^\s&,;]+/gi,
    "$1=[redacted]",
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  // Workspace database names (`wl-` + 16 hex, provisioner.ts).
  [/\bwl-[0-9a-f]{16}/g, "[workspace-db]"],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, "[iban]"],
  // Spanish NIF / NIE.
  [/\b(?:\d{8}|[XYZ]\d{7})[A-HJ-NP-TV-Z]\b/g, "[id]"],
  [/(?<!\w)"[^"\n]*"/g, '"[redacted]"'],
  [/(?<!\w)'[^'\n]*'(?!\w)/g, "'[redacted]'"],
  [/`[^`\n]*`/g, "`[redacted]`"],
  [/«[^»\n]*»/g, "«[redacted]»"],
  // Money-shaped figures: thousands groups optional, exactly two decimals.
  [/\b\d+(?:[.,]\d{3})*[.,]\d{2}\b/g, "[amount]"],
  // Long digit runs: phone, account and card numbers.
  [/\b\d{7,}\b/g, "[number]"],
];

/** Redact everything in an error string that could identify a person or their data. */
export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement as string);
  }
  return result;
}

type StackFrame = NonNullable<
  NonNullable<NonNullable<ErrorEvent["exception"]>["values"]>[number]["stacktrace"]
>["frames"] extends Array<infer F> | undefined
  ? F
  : never;

/** Code location only: no `vars`, no source lines, no frame `module` metadata. */
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
 * The `beforeSend`: rebuild the event from an allowlist. What is copied is the
 * diagnosis — the error type, its message redacted, where in OUR code it broke,
 * which route pattern — and what is not copied cannot leak, whatever the SDK
 * attached upstream.
 */
export function scrubErrorEvent(event: ErrorEvent): ErrorEvent {
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
  if (event.fingerprint) scrubbed.fingerprint = event.fingerprint.map(redactText);
  // `captureRequestError` names it `METHOD /route/[pattern]` — the pattern, not the path.
  if (event.transaction !== undefined)
    scrubbed.transaction = redactText(event.transaction);
  if (event.message !== undefined) scrubbed.message = redactText(event.message);
  if (event.logentry?.message !== undefined) {
    scrubbed.logentry = { message: redactText(event.logentry.message) };
  }

  if (event.exception?.values) {
    scrubbed.exception = {
      values: event.exception.values.map((value) => ({
        ...(value.type !== undefined ? { type: value.type } : {}),
        ...(value.value !== undefined ? { value: redactText(value.value) } : {}),
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
