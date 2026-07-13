#!/usr/bin/env node
/**
 * Turbopack emits `.next/server/**` bundles (middleware.js, page/api funcs,
 * instrumentation.js) as CommonJS — `require(...)` / `module.exports`. But
 * `apps/web/package.json` is `"type": "module"` (required by the build: the
 * app source is ESM). Vercel CLI 55+ traces that app package.json into every
 * serverless function; at runtime the Node launcher `require()`s the CJS
 * bundle, Node finds the governing `type:module` and treats it as ESM →
 * `ERR_REQUIRE_ESM` → MIDDLEWARE_INVOCATION_FAILED (500 on every route). See
 * docs/agents/incident-2026-07-10-vercel-cli-500.md.
 *
 * Fix: drop `.next/server/package.json` = `{"type":"commonjs"}`. It is closer
 * to the bundles than `apps/web/package.json`, so Node loads them as CJS. The
 * catch: Vercel's file tracer (@vercel/nft) does NOT pick up a bare sibling
 * package.json on its own — verified against CLI 55.0.0. So we also register
 * the marker in Next's per-function `*.nft.json` traces, which Vercel consumes
 * when assembling each function's file map. This lets us unpin the Vercel CLI
 * (issue #848).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "apps/web/.next/server");

if (!existsSync(serverDir)) {
  throw new Error(
    `Expected ${serverDir} to exist after \`next build\`; postbuild CJS marker cannot be emitted.`,
  );
}

// Guard: the marker only helps if the bundles it governs are actually CJS.
// If a future Turbopack emits ESM to `.next/server`, a `type:commonjs` marker
// would be actively harmful (Node would load real ESM as CJS). Fail loudly
// rather than ship the opposite bug. `middleware.js` is the incident file and
// is always present while `proxy.ts` exists.
const sampleBundle = join(serverDir, "middleware.js");
if (existsSync(sampleBundle)) {
  const source = readFileSync(sampleBundle, "utf8");
  if (!/\bmodule\.exports\b|\brequire\(/.test(source)) {
    throw new Error(
      `${sampleBundle} no longer looks like CommonJS; a {"type":"commonjs"} marker would misload it. ` +
        "Re-verify the Vercel CLI packaging (issue #848) before shipping.",
    );
  }
}

const markerPath = join(serverDir, "package.json");
writeFileSync(markerPath, `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);

// Walk every `*.nft.json` trace under .next/server and add a relative entry
// pointing at the marker, so Vercel includes it in each function's file map.
function collectNftTraces(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectNftTraces(full, acc);
    else if (entry.name.endsWith(".nft.json")) acc.push(full);
  }
  return acc;
}

const traces = collectNftTraces(serverDir, []);

// Fail loudly if the trace layout drifts (renamed/relocated by a Next bump).
// A silent no-op here re-ships the exact 2026-07-10 outage: a sibling marker
// with zero nft registration is the failed attempt the incident doc records.
if (traces.length === 0) {
  throw new Error(
    `No *.nft.json traces under ${serverDir}; cannot register the CJS marker. ` +
      "Next's trace output likely changed — re-verify the fix (issue #848).",
  );
}

let patched = 0;
for (const nftPath of traces) {
  const trace = JSON.parse(readFileSync(nftPath, "utf8")) as {
    version: number;
    files: string[];
  };
  // nft `files` are relative to the traced file, which sits alongside its
  // `<file>.nft.json`. Point that same base at the marker.
  const rel = relative(dirname(nftPath), markerPath);
  if (!trace.files.includes(rel)) {
    trace.files.push(rel);
    writeFileSync(nftPath, JSON.stringify(trace));
    patched += 1;
  }
  // Post-condition (holds on fresh builds and idempotent re-runs alike): every
  // trace must reference the marker, else that function ships without CJS
  // governance and 500s on every request.
  if (!trace.files.includes(rel)) {
    throw new Error(`Failed to register CJS marker in ${nftPath}.`);
  }
}

console.log(
  `Emitted .next/server/package.json = {"type":"commonjs"}; ${traces.length} nft traces reference it (${patched} newly patched).`,
);
