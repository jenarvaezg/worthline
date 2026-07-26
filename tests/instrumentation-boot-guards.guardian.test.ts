import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * The boot guards only protect anything while they are WIRED into the startup
 * hook. `apps/web/app/production-config.test.ts` and
 * `apps/web/app/encryption-config.test.ts` prove each decision; this proves
 * `register()` still runs them, so deleting a call cannot silently reopen a
 * production deploy that serves every page — `/api/mcp` included — with no
 * sign-in wall (#1181, ADR 0030).
 *
 * A source sweep rather than an import: `instrumentation.ts` lives at the
 * `apps/web` root, outside every zone alias (#361), so no test may import it.
 * Being text, it is coupled to how the calls are written — see the failure hint
 * below, and update this file (don't delete it) when the hook is refactored.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The hook's executable source: comments stripped and whitespace collapsed, so a
 * docblock merely naming a guard can never satisfy the sweep (nor invert the
 * order check), and a reformatted line break cannot fail it.
 */
const CODE = readFileSync(join(REPO_ROOT, "apps/web/instrumentation.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "")
  .replace(/\s+/g, " ");

/** The assertions the Node.js boot must run, with the module each comes from. */
const BOOT_GUARDS = [
  { assertion: "assertProductionConfigured", module: "@web/production-config" },
  { assertion: "assertSecretEncryptionConfigured", module: "@web/encryption-config" },
] as const;

const HINT =
  "apps/web/instrumentation.ts must still import and call this boot guard; " +
  "if the call was only reworded, update this guardian, never drop the guard";

describe("instrumentation boot guards (#1181)", () => {
  test.each(BOOT_GUARDS)("register() imports and calls $assertion", ({
    assertion,
    module,
  }) => {
    expect(CODE, HINT).toContain(`await import("${module}")`);
    expect(CODE, HINT).toContain(`${assertion}(process.env)`);
  });

  test("the auth assertion runs before the encryption one", () => {
    // The encryption guard keys off auth being configured, so in a deploy with
    // no auth config it stays silent — the auth message is the actionable one.
    const [auth, encryption] = BOOT_GUARDS.map(({ assertion }) =>
      CODE.indexOf(`${assertion}(process.env)`),
    );
    expect(auth).toBeGreaterThan(-1);
    expect(encryption).toBeGreaterThan(auth);
  });
});
