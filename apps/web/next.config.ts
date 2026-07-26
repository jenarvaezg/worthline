import type { NextConfig } from "next";
import { securityHeaders } from "./app/security-headers";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Don't advertise the framework (#1179).
  poweredByHeader: false,
  // Security headers on every route (#1179). Vercel doesn't inject these; the
  // CSP ships report-only first so we can observe breakage before enforcing.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({ dev: process.env.NODE_ENV !== "production" }),
      },
    ];
  },
  experimental: {
    // Enable React 19 / Next 16 View Transitions API integration.
    // Route navigations automatically become transitions; <ViewTransition>
    // components from 'react' can then animate named elements (ADR 0036 §5,
    // interaction-patterns §5).
    viewTransition: true,
    // Router Cache reuse for recently-visited dynamic segments (#1191, perf
    // umbrella #1189). Next 16 defaults `dynamic` to 0, so every re-visit of an
    // already-seen tab repays a full RSC render against remote Turso. 30s lets
    // the client router reuse a segment visited within the window — going back
    // to a tab is instant, no server round-trip.
    //
    // Safety: this only governs client-side navigation reuse. Post-mutation
    // freshness is kept by the `formAction` combinator (app/form-action.ts),
    // which pairs `revalidatePath("/", "layout")` — evicting the prefetch cache,
    // so OTHER tabs re-render — with `refresh()`, which re-renders the CURRENT
    // tree from the action response.
    //
    // AMENDED after #1180: the original note here claimed `revalidatePath` alone
    // made this safe "regardless of staleTimes". It did not. Next's server-action
    // reducer invalidates the prefetch cache and then starts a re-prefetch
    // cooldown, during which the current page does NOT re-render until a
    // navigation occurs — and our terminal redirect is frequently to the
    // byte-identical URL the user is already on, because `appendParam` uses
    // `URLSearchParams.set` (two mutations sharing an `ok` token land on the same
    // URL). The result was a mutation committed on the server while the DOM kept
    // showing pre-mutation state: reproduced as a ~12% e2e failure rate, fixed by
    // adding `refresh()`. Do not drop either call.
    //
    // Residual risk, unchanged: out-of-session changes (another device, the daily
    // cron) can go unseen for up to 30s — acceptable for this data.
    staleTimes: {
      dynamic: 30,
    },
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
