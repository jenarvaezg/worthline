import type { NextConfig } from "next";
import { securityHeaders } from "./app/security-headers";

const nextConfig: NextConfig = {
  // Instant Navigations (#1229): Cache Components + Partial Prefetching so each
  // workspace tab paints its prefetched shell (chrome + Suspense skeleton) on
  // soft click without a server round-trip.
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
    // Router Cache for dynamic navigations (#1531): a revisit inside this
    // window is served from the client cache with no server round-trip.
    // #1229 retired this believing `cacheComponents` had replaced it — false,
    // the repo ships zero `"use cache"` directives. Rationale, measurement and
    // long-term replacement (`"use cache"` + `cacheLife`): #1531;
    // `app/router-cache.test.ts` guards against silent removal.
    staleTimes: { dynamic: 30 },
    // NOTE: `viewTransition` is deliberately absent (#1379). The flag only
    // resolves a React build that EXPORTS `<ViewTransition>`; it does not add a
    // boundary, and without one React never sets `shouldStartViewTransition`, so
    // the whole layer was inert. Retired rather than revived — ADR 0036 §5 has
    // the reasoning, `app/retired-view-transitions.test.ts` guards it.
    //
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
  // sharp / libvips are 18 MB of a 41 MB page lambda for an image runtime
  // Vercel already provides (#1536). Keep them out of every function trace.
  outputFileTracingExcludes: {
    "*": ["node_modules/@img/**", "node_modules/sharp/**"],
  },
  // Type-checking is its own CI gate (.github/workflows/ci.yml runs typecheck +
  // lint + format + tests + build on every push). The deploy build (Vercel
  // installs production deps only) skips re-running it so it doesn't need the
  // dev-only `typescript` package. (Next 16 no longer lints during build.)
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
