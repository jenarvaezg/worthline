import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { appCookieOptions } from "./app-cookie";
import { readSourceFiles, stripComments } from "./guardian-walk";

/** The helper reads NODE_ENV at call time, so a test can drive both branches. */
function setNodeEnv(value: string): void {
  vi.stubEnv("NODE_ENV", value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("app cookie options (#1180)", () => {
  test("production is httpOnly + lax + secure, scoped to the whole site", () => {
    setNodeEnv("production");

    expect(appCookieOptions()).toEqual({
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  });

  test("secure is off outside production so plain-http local dev still works", () => {
    setNodeEnv("development");
    expect(appCookieOptions().secure).toBe(false);

    setNodeEnv("test");
    expect(appCookieOptions().secure).toBe(false);
  });

  test("a caller may add a bounded lifetime without losing the baseline flags", () => {
    setNodeEnv("production");

    expect(appCookieOptions({ maxAge: 60 })).toEqual({
      httpOnly: true,
      maxAge: 60,
      path: "/",
      sameSite: "lax",
      secure: true,
    });
  });
});

/**
 * Tripwire: the helper is only a fix if nothing bypasses it. `secure` went
 * missing from three of the four app cookies precisely because each set-site
 * spelled the options out by hand, so the build goes red if a new one does.
 */
const APP_COOKIE_CONSTANTS = [
  "SCOPE_COOKIE_NAME",
  "PRIVACY_COOKIE_NAME",
  "DEMO_PERSONA_COOKIE_NAME",
  "IMPERSONATE_COOKIE_NAME",
] as const;

/**
 * The app cookies this source sets WITHOUT handing the options to
 * {@link appCookieOptions} — i.e. by spelling an options object out by hand.
 * `.delete(…)` is untouched: clearing a cookie carries no transport posture.
 * Empty array = passes.
 */
export function cookiesSetWithoutHelper(source: string): string[] {
  const code = stripComments(source);
  return APP_COOKIE_CONSTANTS.filter((constant) =>
    // Every set-site for this constant is checked, not just the first: a file may
    // legitimately set the same cookie from two places.
    [...code.matchAll(new RegExp(`\\.set\\(\\s*${constant}\\b[\\s\\S]*?\\);`, "g"))].some(
      (call) => !call[0].includes("appCookieOptions"),
    ),
  );
}

describe("app cookie tripwire · nothing spells the options out by hand (#1180)", () => {
  const webRoot = join(import.meta.dirname, "..");
  const sources = readSourceFiles(webRoot);

  test.each(
    sources.map((s) => [s.filePath, s.source] as const),
  )("sets app cookies through the helper: %s", (filePath, source) => {
    const found = cookiesSetWithoutHelper(source);
    expect(
      found,
      `${filePath.slice(webRoot.length + 1)} must pass appCookieOptions() when setting ${found.join(", ")} — an inline options object is how \`secure\` went missing`,
    ).toEqual([]);
  });

  test("the walk is not vacuous and the known set-sites are in it", () => {
    expect(sources.length).toBeGreaterThan(100);
    const relative = new Set(sources.map((s) => s.filePath.slice(webRoot.length + 1)));
    for (const setSite of [
      "app/scope/route.ts",
      "app/privacy/route.ts",
      "app/demo/persona/route.ts",
      "app/admin/actions.ts",
      "app/empezar/actions.ts",
      "app/(workspace)/ajustes/actions.ts",
    ]) {
      expect(relative.has(setSite), `${setSite} must be in the walk`).toBe(true);
    }
  });

  test("detects a hand-written options object (intentional red case)", () => {
    expect(
      cookiesSetWithoutHelper(
        `response.cookies.set(SCOPE_COOKIE_NAME, scopeId, {\n` +
          `  httpOnly: true,\n  path: "/",\n  sameSite: "lax",\n});\n`,
      ),
    ).toEqual(["SCOPE_COOKIE_NAME"]);
  });

  test("the helper form passes, and clearing a cookie is not a set", () => {
    expect(
      cookiesSetWithoutHelper(
        `response.cookies.set(SCOPE_COOKIE_NAME, scopeId, appCookieOptions());\n`,
      ),
    ).toEqual([]);

    expect(
      cookiesSetWithoutHelper(`response.cookies.delete(SCOPE_COOKIE_NAME);\n`),
    ).toEqual([]);
  });
});
