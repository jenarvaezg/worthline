import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, test } from "vitest";

import {
  ERROR_MONITORING_DSN_ENV,
  errorMonitoringDsn,
  errorMonitoringOptions,
  redactText,
  type SentryIntegration,
  scrubErrorEvent,
} from "./error-monitoring";

/**
 * The privacy promise of the error monitor, in code (#1175). The policy text
 * (`/legal/privacidad`) says Sentry receives technical error reports «con los
 * datos personales filtrados antes de enviarse» and nothing else: no tracing,
 * no replay, no sessions, no analytics. These tests are that sentence.
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

  test("never turns tracing on", () => {
    // Defining either key — even as 0 — switches the tracing machinery on.
    expect(options).not.toHaveProperty("tracesSampleRate");
    expect(options).not.toHaveProperty("tracesSampler");
    // …and no trace headers ride along on outgoing requests to third parties.
    expect(options.tracePropagationTargets).toEqual([]);
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

describe("redactText (#1175)", () => {
  test.each([
    ["owner ana.perez@example.com not found", "owner [email] not found"],
    ['Holding "Piso de la playa" has no price', 'Holding "[redacted]" has no price'],
    ["Activo «Fondo indexado» sin precio", "Activo «[redacted]» sin precio"],
    ["cannot parse 'cuenta nómina'", "cannot parse '[redacted]'"],
    [
      "balance 1.234,56 does not match 1234.56",
      "balance [amount] does not match [amount]",
    ],
    ["IBAN ES91 2100 0418 4502 0005 1332 rejected", "IBAN [iban] rejected"],
    ["NIF 12345678Z and NIE X1234567L", "NIF [id] and NIE [id]"],
    ["phone 612345678", "phone [number]"],
    [
      "fetch libsql://wl-0123456789abcdef-org.turso.io?authToken=abc failed",
      "fetch libsql://[workspace-db]-org.turso.io?[redacted] failed",
    ],
    [
      "https://user:pass@api.example.com/v1/x?q=1#frag",
      "https://[credentials]@api.example.com/v1/x?[redacted]",
    ],
    ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "Bearer [token]"],
    ["token=s3cr3t and apiKey: k3y", "token=[redacted] and apiKey=[redacted]"],
    ["workspace 3f2b8c1e-9d4a-4f6b-8e2a-1c5d7e9f0a3b missing", "workspace [id] missing"],
  ])("%j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  test("leaves code-shaped diagnostics readable", () => {
    expect(redactText("Cannot read properties of undefined (reading 'map')")).toBe(
      "Cannot read properties of undefined (reading '[redacted]')",
    );
    expect(
      redactText("SQLITE_CONSTRAINT: UNIQUE constraint failed: grants.user_id"),
    ).toBe("SQLITE_CONSTRAINT: UNIQUE constraint failed: grants.user_id");
    expect(redactText("next 16.3.0 failed after 3 retries")).toBe(
      "next 16.3.0 failed after 3 retries",
    );
    expect(redactText("can't resolve the module")).toBe("can't resolve the module");
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
          value: 'Holding "Piso de la playa" of ana@example.com has no price',
        },
      ],
    },
    extra: { workspace: { assets: ["Piso"] } },
    level: "error",
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
    ]) {
      expect(scrubbed, field).not.toHaveProperty(field);
    }
    expect(serialized).not.toContain("ana@example.com");
    expect(serialized).not.toContain("Piso");
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("authjs");
    expect(serialized).not.toContain("250.000,00");
    expect(serialized).not.toContain("wl-0123456789abcdef");
    expect(serialized).not.toContain("tab=historico");
  });

  test("keeps the diagnosis: error type, redacted message, code location, route pattern", () => {
    expect(scrubbed.exception?.values?.[0]).toEqual({
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
      value: 'Holding "[redacted]" of [email] has no price',
    });
    expect(scrubbed.message).toBe("valor [amount] € para [email]");
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

  test("is wired as the beforeSend of the options", () => {
    const options = errorMonitoringOptions(DSN);
    const sent = options.beforeSend?.(hostileEvent(), {});
    expect(JSON.stringify(sent)).not.toContain("ana@example.com");
  });
});
