import { captureRequestError, init } from "@sentry/nextjs";
import { errorMonitoringOptions } from "@web/error-monitoring";
import type { Instrumentation } from "next";

/**
 * The Sentry SDK half of error monitoring (#1175) — the only module that loads
 * `@sentry/nextjs`. `instrumentation.ts` imports it dynamically, and only when a
 * DSN is configured, so a deploy without one never even loads the SDK.
 * Everything that decides WHAT is sent lives in `error-monitoring.ts`.
 */

/**
 * The env var the SDK reads as a sample rate whenever the option is absent —
 * and in this app the option is ALWAYS absent, because defining it at all turns
 * tracing on.
 */
const TRACES_SAMPLE_RATE_ENV = "SENTRY_TRACES_SAMPLE_RATE";

/** Initialize the server SDK with the errors-only, scrubbed configuration. */
export function startErrorMonitoring(
  dsn: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (env[TRACES_SAMPLE_RATE_ENV] !== undefined) {
    // Errors only (#1131): a sample rate inherited from the environment must not
    // be able to switch tracing on behind the code's back.
    console.warn(
      `error-monitoring: ignoring ${TRACES_SAMPLE_RATE_ENV} — worthline sends errors only, never traces.`,
    );
    delete env[TRACES_SAMPLE_RATE_ENV];
  }
  init(errorMonitoringOptions(dsn));
}

/**
 * Report a server error Next.js caught (RSC render, route handler, server
 * action, proxy). The SDK names the event after the route PATTERN; the request's
 * headers it receives never survive `beforeSend`.
 */
export function reportRequestError(
  ...args: Parameters<Instrumentation.onRequestError>
): void {
  captureRequestError(...args);
}
