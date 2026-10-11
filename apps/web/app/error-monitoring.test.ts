import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, test } from "vitest";

import {
  ERROR_MONITORING_DSN_ENV,
  errorMonitoringDsn,
  errorMonitoringOptions,
  OMITTED_ERROR_TEXT,
  type SentryIntegration,
  scrubErrorEvent,
} from "./error-monitoring";

/**
 * The privacy promise of the error monitor, in code (#1175, ADR 0110). The
 * policy text (`/legal/privacidad`) says Sentry receives the type of a server
 * error, where in the code it broke and on which screen — never the text of the
 * error, the person or their workspace — and nothing else: no tracing, no
 * replay, no sessions, no analytics. These tests are that sentence.
 */

// A fake DSN in Sentry's documented shape; no real project behind it.
const DSN = "https://publickey@o0.ingest.example.invalid/0";

describe("errorMonitoringDsn (#1175)", () => {
  test("reads the DSN from its env var", () => {
    expect(ERROR_MONITORING_DSN_ENV).toBe("SENTRY_DSN");
    expect(errorMonitoringDsn({ SENTRY_DSN: ` ${DSN} ` })).toBe(DSN);
  });

  test("no DSN means no monitoring at all — not even an init", () => {
    expect(errorMonitoringDsn({})).toBeNull();
    expect(errorMonitoringDsn({ SENTRY_DSN: "" })).toBeNull();
    expect(errorMonitoringDsn({ SENTRY_DSN: "   " })).toBeNull();
  });
});

describe("errorMonitoringOptions · errors only (#1175, #1131)", () => {
  const options = errorMonitoringOptions(DSN);

  test("never turns tracing on, by any door", () => {
    // Defining either key — even as 0 — switches the tracing machinery on.
    expect(options).not.toHaveProperty("tracesSampleRate");
    expect(options).not.toHaveProperty("tracesSampler");
    expect(options.enableOpenTelemetrySetup).toBe(false);
    expect(options.beforeSendTransaction?.({ type: "transaction" }, {})).toBeNull();
    // …no trace headers ride along on outgoing requests to third parties…
    expect(options.tracePropagationTargets).toEqual([]);
    // …and SENTRY_SPOTLIGHT cannot switch the development sidecar on.
    expect(options.spotlight).toBe(false);
  });

  test("collects no request, user, cookie, header, body or local-variable data", () => {
    expect(options.dataCollection).toEqual({
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
    });
    expect(options.includeLocalVariables).toBe(false);
    expect(options.includeServerName).toBe(false);
  });

  test("keeps no breadcrumbs, logs, metrics or client reports", () => {
    expect(options.maxBreadcrumbs).toBe(0);
    expect(
      options.beforeBreadcrumb?.({ message: "GET /patrimonio" }, undefined),
    ).toBeNull();
    expect(options.beforeSendLog?.({ level: "info", message: "x" } as never)).toBeNull();
    expect(options.beforeSendMetric?.({ name: "x" } as never)).toBeNull();
    expect(options.sendClientReports).toBe(false);
  });

  test("does not rewrite the app's own error messages", () => {
    expect(options.enhanceFetchErrorMessages).toBe(false);
  });

  test("keeps only the error-capture integrations, whatever the SDK adds by default", () => {
    const defaults = [
      "Console",
      "Context",
      "ContextLines",
      "Dedupe",
      "DistDirRewriteFrames",
      "EventFilters",
      "FunctionToString",
      "Http",
      "LinkedErrors",
      "LocalVariables",
      "Modules",
      "NodeFetch",
      "OnUncaughtException",
      "OnUnhandledRejection",
      "ProcessSession",
      "RequestData",
      "SomeFutureIntegration",
    ].map((name) => ({ name }) as SentryIntegration);

    const integrations = options.integrations;
    if (typeof integrations !== "function") throw new Error("expected a filter function");
    expect(integrations(defaults).map((integration) => integration.name)).toEqual([
      "Context",
      "Dedupe",
      "EventFilters",
      "FunctionToString",
      "LinkedErrors",
      "OnUncaughtException",
      "OnUnhandledRejection",
    ]);
  });
});

function hostileEvent(): ErrorEvent {
  return {
    breadcrumbs: [{ message: "GET /patrimonio?q=piso" }],
    contexts: {
      cloud_resource: { "cloud.provider": "vercel" },
      nextjs: {
        request_path: "/patrimonio/wl_hld_123?tab=historico",
        route_type: "render",
        router_kind: "App Router",
        router_path: "/(workspace)/patrimonio/[id]",
      },
      os: { name: "Linux" },
      runtime: { name: "node", version: "v24.0.0" },
      trace: {
        span_id: "1234567890abcdef",
        trace_id: "0123456789abcdef0123456789abcdef",
      },
    },
    environment: "production",
    event_id: "abc",
    exception: {
      values: [
        {
          type: "LibsqlError",
          value: "connect libsql://wl-0123456789abcdef-org.turso.io?authToken=abc",
        },
        {
          mechanism: {
            data: { leaked: "x" },
            handled: false,
            type: "auto.function.nextjs",
          },
          stacktrace: {
            frames: [
              {
                abs_path: "/var/task/apps/web/.next/server/chunks/ssr/page.js",
                colno: 7,
                context_line: 'const label = "Piso de la playa";',
                filename: "app:///patrimonio/page.js",
                function: "renderHolding",
                in_app: true,
                lineno: 42,
                post_context: ["}"],
                pre_context: ["{"],
                vars: { label: "Piso de la playa", owner: "ana@example.com" },
              },
            ],
          },
          type: "Error",
          value:
            "Holding Piso de la playa of ana@example.com has no price at 250.000,00 €",
        },
      ],
    },
    extra: { workspace: { assets: ["Piso"] } },
    fingerprint: ["Piso de la playa"],
    level: "error",
    logentry: { message: "valor %s", params: ["250.000,00 €"] },
    message: "valor 250.000,00 € para ana@example.com",
    modules: { next: "16.3.0" },
    platform: "node",
    release: "abc123",
    request: {
      cookies: { "authjs.session-token": "jwt" },
      data: '{"label":"Piso"}',
      headers: { cookie: "authjs.session-token=jwt", "x-forwarded-for": "203.0.113.7" },
      method: "GET",
      query_string: "q=piso",
      url: "https://worthline.example/patrimonio?q=piso",
    },
    sdk: {
      integrations: ["Dedupe"],
      name: "sentry.javascript.nextjs",
      version: "11.6.0",
    },
    server_name: "ip-10-0-0-1",
    tags: { "workspace.id": "wl-0123456789abcdef", turbopack: true },
    timestamp: 1_700_000_000,
    transaction: "GET /(workspace)/patrimonio/[id]",
    type: undefined,
    user: { email: "ana@example.com", id: "u1", ip_address: "203.0.113.7" },
  };
}

describe("scrubErrorEvent · beforeSend (#1175)", () => {
  const scrubbed = scrubErrorEvent(hostileEvent());
  const serialized = JSON.stringify(scrubbed);

  test("drops every field that can carry the person or the workspace", () => {
    for (const field of [
      "user",
      "request",
      "extra",
      "breadcrumbs",
      "server_name",
      "modules",
      "tags",
      "fingerprint",
    ]) {
      expect(scrubbed, field).not.toHaveProperty(field);
    }
    for (const leak of [
      "ana@example.com",
      "Piso",
      "203.0.113.7",
      "authjs",
      "250.000,00",
      "wl-0123456789abcdef",
      "authToken",
      "tab=historico",
      "has no price",
    ]) {
      expect(serialized, leak).not.toContain(leak);
    }
  });

  test("sends no free text at all: every message becomes the marker", () => {
    expect(scrubbed.exception?.values?.map((value) => value.value)).toEqual([
      OMITTED_ERROR_TEXT,
      OMITTED_ERROR_TEXT,
    ]);
    expect(scrubbed.message).toBe(OMITTED_ERROR_TEXT);
    expect(scrubbed.logentry).toEqual({ message: OMITTED_ERROR_TEXT });
  });

  test("keeps the shape of the failure: error class, code location, route pattern", () => {
    expect(scrubbed.exception?.values?.[1]).toEqual({
      mechanism: { handled: false, type: "auto.function.nextjs" },
      stacktrace: {
        frames: [
          {
            abs_path: "/var/task/apps/web/.next/server/chunks/ssr/page.js",
            colno: 7,
            filename: "app:///patrimonio/page.js",
            function: "renderHolding",
            in_app: true,
            lineno: 42,
          },
        ],
      },
      type: "Error",
      value: OMITTED_ERROR_TEXT,
    });
    expect(scrubbed.exception?.values?.[0]?.type).toBe("LibsqlError");
    expect(scrubbed.transaction).toBe("GET /(workspace)/patrimonio/[id]");
    expect(scrubbed.contexts).toEqual({
      nextjs: {
        route_type: "render",
        router_kind: "App Router",
        router_path: "/(workspace)/patrimonio/[id]",
      },
      os: { name: "Linux" },
      runtime: { name: "node", version: "v24.0.0" },
      trace: {
        span_id: "1234567890abcdef",
        trace_id: "0123456789abcdef0123456789abcdef",
      },
    });
    expect(scrubbed).toMatchObject({
      environment: "production",
      event_id: "abc",
      level: "error",
      platform: "node",
      release: "abc123",
      sdk: { name: "sentry.javascript.nextjs", version: "11.6.0" },
      timestamp: 1_700_000_000,
    });
  });

  test("carries Next's render digest, the key to the full error in the runtime logs", () => {
    const withDigest = scrubErrorEvent(hostileEvent(), {
      originalException: Object.assign(new Error("Piso de la playa"), {
        digest: "3565469810",
      }),
    });
    expect(withDigest.exception?.values?.[1]?.value).toBe(
      `${OMITTED_ERROR_TEXT} · digest 3565469810`,
    );
    // A «digest» that is not digest-shaped is not trusted into the event.
    const forged = scrubErrorEvent(hostileEvent(), {
      originalException: { digest: "ana@example.com has a Piso" },
    });
    expect(forged.exception?.values?.[1]?.value).toBe(OMITTED_ERROR_TEXT);
  });

  test("a transaction that is not a route pattern is not copied", () => {
    for (const transaction of [
      "GET /patrimonio?q=piso",
      "Piso de la playa",
      "/patrimonio sin método",
    ]) {
      expect(scrubErrorEvent({ ...hostileEvent(), transaction })).not.toHaveProperty(
        "transaction",
      );
    }
  });

  test("is wired as the beforeSend of the options", () => {
    const options = errorMonitoringOptions(DSN);
    const sent = options.beforeSend?.(hostileEvent(), {});
    expect(JSON.stringify(sent)).not.toContain("ana@example.com");
    expect(JSON.stringify(sent)).toContain(OMITTED_ERROR_TEXT);
  });
});
