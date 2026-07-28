import type { NextConfig } from "next";
import { securityHeaders } from "./app/security-headers";

const nextConfig: NextConfig = {
  // Instant Navigations (#1229): Cache Components + Partial Prefetching so each
  // workspace tab paints its prefetched shell (chrome + Suspense skeleton) on
  // soft click without a server round-trip. Replaces the Router Cache
  // `staleTimes.dynamic` knob from #1191 — that model no longer applies once
  // cacheComponents owns the caching contract.
  cacheComponents: true,
  partialPrefetching: true,
  devIndicators: false,
  // Don't advertise the framework (#1179).
  poweredByHeader: false,
  // Security headers on every route (#1179). Vercel doesn't inject these; the
  // CSP ships report-only first so we can observe breakage before enforcing.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({
          dev: process.env.NODE_ENV !== "production",
        }),
      },
    ];
  },
  experimental: {
    // Enable React 19 / Next 16 View Transitions API integration.
    // Route navigations automatically become transitions; <ViewTransition>
    // components from 'react' can then animate named elements (ADR 0036 §5,
    // interaction-patterns §5).
    viewTransition: true,
    // Instant Navigation Testing API (#1229). `instant()` from @next/playwright
    // is a cookie the CLIENT BUNDLE must be compiled to honour: Next inlines
    // `__NEXT_EXPOSE_TESTING_API` as `dev || exposeTestingApiInProductionBuild`,
    // so in a production build without this flag the navigation lock is dead
    // code and the helper silently does nothing — journey 48 then asserted a
    // race (skeleton vs. dynamic data) instead of the shell, and lost it in CI
    // wherever the server was warm enough to answer first.
    //
    // Gated on an env var because the flag exposes a testing hook: only the e2e
    // build turns it on (`bun run --filter @worthline/web build:e2e`, which CI's
    // `E2E setup` job runs). A deploy build never sets it.
    exposeTestingApiInProductionBuild: process.env.WORTHLINE_EXPOSE_TESTING_API === "1",
  },
  transpilePackages: ["@worthline/db", "@worthline/domain", "@worthline/pricing"],
  // @libsql/client pulls in a native addon (the `libsql` package) for local
  // file/:memory: databases. Keep both external so Next / Vercel's server file
  // tracing doesn't try to bundle the native binary into the serverless function;
  // they're required at runtime from node_modules in the Node lambda (ADR 0030).
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Type-checking is its own CI gate (.github/workflows/ci.yml runs typecheck +
  // lint + format + tests + build on every push). The deploy build (Vercel
  // installs production deps only) skips re-running it so it doesn't need the
  // dev-only `typescript` package. (Next 16 no longer lints during build.)
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
