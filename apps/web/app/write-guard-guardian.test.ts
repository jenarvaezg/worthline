/**
 * Write-guard guardian (#1180) — the second test-guardián of the mutation seam,
 * next to `authz-seam-guardian` (who may open a store) and `design-system-guardian`
 * (#828, what a surface may look like).
 *
 * The invariant: **every server action that can write must pass a write guard.**
 * The read-only demo (ADR 0030) and admin impersonation (#697) are enforced by a
 * guard on the action's first line, not by the UI hiding the button — a direct
 * POST must be refused. Today the `formAction`/proposal combinators own that
 * choreography for most actions (PRD #1112) and a handful call the guard by hand
 * (`inversiones/actions.ts`, `importar-extracto/actions.ts`, the admin actions).
 * Nothing stopped the NEXT hand-rolled action from forgetting it — the hole this
 * closes. The build goes red here the moment an exported action in a `"use server"`
 * module reaches neither a combinator nor a guard.
 *
 * Accepted coverage, all of them real gates rather than conventions:
 *   - `formAction` / `formActionState` — the combinator runs `guardDemoWrite` in
 *     its shared front matter, so every action built from it is covered by
 *     construction.
 *   - `runProposalConfirm` / `runProposalDiscard` — the proposal combinators run
 *     `guardProposalWrite` before touching a store.
 *   - `guardDemoWrite` / `guardProposalWrite` / `isWriteBlocked` — called by hand.
 *   - `guardAdmin` — a STRICTER gate, not a weaker one: it 404s anyone who is not
 *     the configured admin, and the demo never carries a real session, so a demo
 *     write cannot reach an admin action at all. The admin actions also write to
 *     the control plane rather than an impersonated workspace, so impersonation
 *     read-only is not the relevant axis there.
 *
 * Coverage is TRANSITIVE within a module: an exported action that delegates to a
 * module-local helper which itself runs a combinator is covered (the shape of
 * `holding-trash-proposal-action.ts`). Comments are stripped first, so naming a
 * guard in prose never counts.
 *
 * OUT of scope by design, and deliberately not claimed: inline `"use server"`
 * closures inside a page/component (`patrimonio/[id]/editar/page.tsx`, the
 * `login` / sign-out forms). They are thin bindings over a module-level action or
 * over Auth.js `signIn`/`signOut`, and covering them would need real scope
 * analysis. The mutation frontier they can reach is already fenced by
 * `authz-seam-guardian`: no surface opens a store on its own.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const webRoot = join(import.meta.dirname, "..");

/** Build output / tooling / vendored dirs the walk must never descend. */
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", "public", "test-results"]);

/**
 * Identifiers that constitute passing a write guard. See the module docblock for
 * why each one counts.
 */
const WRITE_GUARDS = [
  "formAction",
  "formActionState",
  "runProposalConfirm",
  "runProposalDiscard",
  "guardDemoWrite",
  "guardProposalWrite",
  "isWriteBlocked",
  "guardAdmin",
] as const;

/**
 * Exported actions allowed to skip a write guard, keyed `path::action`, each with
 * the reason. Deliberately EMPTY: every action in the app is covered today, so an
 * addition here is a visible, reviewable act — "this action provably cannot write"
 * — rather than a silent omission. Prefer calling the guard.
 */
const EXEMPT: Readonly<Record<string, string>> = {};

/** A top-level declaration begins at column 0 with one of these keywords. */
const DECLARATION_START =
  /^(?:export\s+default\s+|export\s+)?(?:async\s+function|function|const|let|var|class|enum|interface|type)\b/;

/** `export type` / `export interface` are erased at build time — never actions. */
const ERASED_EXPORT = /^export\s+(?:type|interface)\b/;

interface Declaration {
  name: string;
  exported: boolean;
  body: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Split a module into its top-level declarations. Biome formats this repo, so a
 * top-level declaration is exactly a line starting at column 0 with a declaration
 * keyword and everything indented under it — no brace tokenizer needed. Splitting
 * per declaration (rather than per export) is what keeps the check honest: a
 * guarded helper sitting BELOW an unguarded action must not lend it its guard.
 */
export function topLevelDeclarations(code: string): Declaration[] {
  const lines = code.split("\n");
  const declarations: Declaration[] = [];
  for (const line of lines) {
    const match = DECLARATION_START.test(line)
      ? /(?:async\s+function|function|const|let|var|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(
          line,
        )
      : null;
    if (match) {
      declarations.push({
        name: match[1] ?? "",
        exported: line.startsWith("export"),
        body: `${line}\n`,
      });
      continue;
    }
    const current = declarations.at(-1);
    if (current) current.body += `${line}\n`;
  }
  return declarations.filter((declaration) => !ERASED_EXPORT.test(declaration.body));
}

function callsAny(body: string, names: readonly string[]): boolean {
  return names.some((name) => new RegExp(`\\b${name}\\s*[(<]`).test(body));
}

/**
 * The exported actions of a `"use server"` module that reach neither a combinator
 * nor a write guard, directly or through a module-local helper. Empty array =
 * passes. A source without a module-level `"use server"` is not an action module
 * and is never scanned.
 */
export function unguardedActions(source: string): string[] {
  if (!/^\s*"use server";/.test(source)) return [];

  const declarations = topLevelDeclarations(stripComments(source));
  const byName = new Map(declarations.map((d) => [d.name, d]));

  const covered = (declaration: Declaration, seen: Set<string>): boolean => {
    if (seen.has(declaration.name)) return false;
    seen.add(declaration.name);
    if (callsAny(declaration.body, WRITE_GUARDS)) return true;
    // Transitive: delegating to a module-local helper that is itself covered.
    for (const [name, candidate] of byName) {
      if (name === declaration.name) continue;
      if (!callsAny(declaration.body, [name])) continue;
      if (covered(candidate, seen)) return true;
    }
    return false;
  };

  return declarations
    .filter((declaration) => declaration.exported)
    .filter((declaration) => !covered(declaration, new Set()))
    .map((declaration) => declaration.name);
}

function walkSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    if (statSync(fullPath).isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry) || entry.startsWith(".")) continue;
      files.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry)) continue;
    files.push(fullPath);
  }
  return files;
}

function relativePath(absolute: string): string {
  return absolute.slice(repoRoot.length + 1);
}

describe('write-guard guardian · every "use server" action passes a guard (#1180)', () => {
  const actionModules = walkSourceFiles(webRoot)
    .map((filePath) => ({ filePath, source: readFileSync(filePath, "utf8") }))
    .filter(({ source }) => /^\s*"use server";/.test(source));
  const relativeModules = new Set(actionModules.map((m) => relativePath(m.filePath)));

  test.each(
    actionModules.map((m) => [relativePath(m.filePath), m.source] as const),
  )("every exported action reaches a write guard: %s", (rel, source) => {
    const unguarded = unguardedActions(source).filter(
      (name) => EXEMPT[`${rel}::${name}`] === undefined,
    );
    expect(
      unguarded,
      `${rel}: ${unguarded.join(", ")} must go through the formAction/proposal combinator or call a write guard (${WRITE_GUARDS.join(" / ")}) before touching a store`,
    ).toEqual([]);
  });

  // A `test.each([])` passes vacuously: a broken walk (renamed dir, bad
  // `import.meta.dirname`) would go green while checking nothing. Pin a floor and
  // assert the known action modules are in scope, so the gate cannot silently
  // stop guarding.
  test("the walk actually covers the action modules it claims to guard", () => {
    expect(actionModules.length).toBeGreaterThanOrEqual(20);
    for (const module of [
      "apps/web/app/(workspace)/patrimonio/holdings-actions.ts", // combinator-built
      "apps/web/app/inversiones/actions.ts", // guard called by hand
      "apps/web/app/(workspace)/patrimonio/importar-extracto/actions.ts", // ditto
      "apps/web/app/asistente/holding-trash-proposal-action.ts", // transitive coverage
      "apps/web/app/admin/actions.ts", // guardAdmin
      "apps/web/app/bienvenida/actions.ts",
    ]) {
      expect(relativeModules.has(module), `${module} must be in the walk`).toBe(true);
    }
  });

  test("every exemption is documented with a reason", () => {
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(key, "an exemption key is `path::actionName`").toContain("::");
      expect(reason.length, `${key} needs a real reason`).toBeGreaterThan(20);
    }
  });

  // Intentional red cases: prove the detector actually catches a forgotten guard,
  // so a green suite means "no action writes unguarded" — never "the check is
  // vacuous".
  test("detects a hand-rolled action that forgot the guard (intentional red case)", () => {
    expect(
      unguardedActions(
        `"use server";\n` +
          `import { withStore } from "@web/store";\n` +
          `export async function deleteEverythingAction(formData: FormData) {\n` +
          `  await withStore((store) => store.assets.hardDeleteAll());\n` +
          `}\n`,
      ),
    ).toEqual(["deleteEverythingAction"]);
  });

  test("a guard named only in a comment does not count", () => {
    expect(
      unguardedActions(
        `"use server";\n` +
          `// TODO: call guardDemoWrite(currentUrl) here\n` +
          `/* formAction() would own this choreography */\n` +
          `export async function sneakyAction(formData: FormData) {\n` +
          `  await writeSomething(formData);\n` +
          `}\n`,
      ),
    ).toEqual(["sneakyAction"]);
  });

  test("a guarded helper BELOW an unguarded action does not lend it its guard", () => {
    // The subtlest failure mode: splitting per export rather than per declaration
    // would swallow `helper`'s guard into `leakyAction`'s slice and pass.
    expect(
      unguardedActions(
        `"use server";\n` +
          `export async function leakyAction(formData: FormData) {\n` +
          `  await writeSomething(formData);\n` +
          `}\n` +
          `\n` +
          `async function helper(url: string) {\n` +
          `  await guardDemoWrite(url);\n` +
          `}\n`,
      ),
    ).toEqual(["leakyAction"]);
  });

  test("the guarded shapes all pass", () => {
    // By hand.
    expect(
      unguardedActions(
        `"use server";\n` +
          `export async function okAction(formData: FormData) {\n` +
          `  await guardDemoWrite(currentUrlOf(formData));\n` +
          `  await withStore((store) => store.assets.softDelete("x"));\n` +
          `}\n`,
      ),
    ).toEqual([]);

    // Built by the combinator.
    expect(
      unguardedActions(
        `"use server";\nexport const okAction = formAction({\n  run: async () => ({ ok: true }),\n});\n`,
      ),
    ).toEqual([]);

    // Transitive through a module-local helper.
    expect(
      unguardedActions(
        `"use server";\n` +
          `async function confirmVia(kind: string) {\n` +
          `  return runProposalConfirm({ kind });\n` +
          `}\n` +
          `export async function confirmSomethingAction(raw: unknown) {\n` +
          `  return confirmVia("something");\n` +
          `}\n`,
      ),
    ).toEqual([]);
  });

  test("erased exports and non-action modules are not flagged", () => {
    expect(
      unguardedActions(
        `"use server";\n` +
          `export type ActionState = { status: string };\n` +
          `export interface Draft { id: string }\n` +
          `export async function okAction() {\n  await guardDemoWrite("/");\n}\n`,
      ),
    ).toEqual([]);

    // No module-level directive ⇒ not an action module ⇒ never scanned.
    expect(
      unguardedActions(
        `export async function notAnAction() {\n  await writeSomething();\n}\n`,
      ),
    ).toEqual([]);
  });
});
