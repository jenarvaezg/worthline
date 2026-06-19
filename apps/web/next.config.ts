import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: ["@worthline/db", "@worthline/domain", "@worthline/pricing"],
  // better-sqlite3 is a native (.node) addon. Keep it external so Next / Vercel's
  // server file tracing doesn't try to bundle the native binary into the
  // serverless function. It's required at runtime from node_modules in the Node
  // lambda — where it loads fine (verified on Vercel: abi 137, opens fine).
  serverExternalPackages: ["better-sqlite3"],
  // Type-checking is its own CI gate (.github/workflows/ci.yml runs typecheck +
  // lint + format + tests + build on every push). The deploy build (Vercel
  // installs production deps only) skips re-running it so it doesn't need the
  // dev-only `typescript` package. (Next 16 no longer lints during build.)
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
