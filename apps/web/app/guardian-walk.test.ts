import { describe, expect, test } from "vitest";

import { isServerActionModule, stripComments, walkSourceFiles } from "./guardian-walk";

describe("guardian walk (#1180)", () => {
  test("walks the app and excludes its own test files", () => {
    const files = walkSourceFiles(import.meta.dirname);

    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("guardian-walk.ts"))).toBe(true);
    expect(files.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
  });

  test("strips block and line comments", () => {
    expect(stripComments(`/** doc */\nconst a = 1; // trailing\n`)).toBe(
      `\nconst a = 1; \n`,
    );
  });

  describe("isServerActionModule", () => {
    test("recognizes a bare directive", () => {
      expect(isServerActionModule(`"use server";\nexport async function a() {}\n`)).toBe(
        true,
      );
    });

    test("recognizes a directive behind a leading docblock (the fail-open case)", () => {
      // Next allows comments before the directive and this repo's house style is a
      // leading docblock. A guardian that missed this would silently stop guarding
      // exactly the most likely-to-be-written new action module.
      expect(
        isServerActionModule(
          `/**\n * The onboarding actions.\n */\n"use server";\n\nexport async function a() {}\n`,
        ),
      ).toBe(true);

      expect(
        isServerActionModule(
          `// #1234 — the new actions\n"use server";\nexport const a = 1;\n`,
        ),
      ).toBe(true);
    });

    test("does not mistake a prose mention for the directive", () => {
      expect(
        isServerActionModule(
          `/** Kept out of the "use server" concern file. */\nexport const NAME = "x";\n`,
        ),
      ).toBe(false);
    });

    test("does not treat a client component or a plain module as an action module", () => {
      expect(isServerActionModule(`"use client";\nexport const A = () => null;\n`)).toBe(
        false,
      );
      expect(isServerActionModule(`export const a = 1;\n`)).toBe(false);
    });

    test("an inline directive inside a function body is not a module-level one", () => {
      expect(
        isServerActionModule(
          `export default function Page() {\n  async function act() {\n    "use server";\n  }\n}\n`,
        ),
      ).toBe(false);
    });
  });
});
