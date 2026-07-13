import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const appDirectory = dirname(fileURLToPath(import.meta.url));

type CssRule = {
  declarations: Map<string, string>;
  file: string;
  selector: string;
};

type AllowedDeclaration = {
  file: string;
  property: "border-radius" | "box-shadow";
  selector: string;
  value: string;
};

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
  });
}

function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();

  for (const match of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    // Collapse whitespace and drop the padding Biome inserts when it wraps a
    // long value (e.g. multi-stop gradients) so the pinned recipes match the
    // semantic literal regardless of line breaks.
    const value = match[2]!
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")");
    declarations.set(match[1]!, value);
  }

  return declarations;
}

function parseRules(file: string): CssRule[] {
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: { bodyStart: number; selector: string }[] = [];
  const rules: CssRule[] = [];
  let boundary = 0;

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "{") {
      stack.push({
        bodyStart: index + 1,
        selector: source.slice(boundary, index).trim(),
      });
      boundary = index + 1;
      continue;
    }

    if (source[index] !== "}") continue;
    const block = stack.pop();
    if (!block) continue;
    const body = source.slice(block.bodyStart, index);
    if (!body.includes("{")) {
      rules.push({
        declarations: parseDeclarations(body),
        file: relative(appDirectory, file),
        selector: block.selector.replace(/\s+/g, " "),
      });
    }
    boundary = index + 1;
  }

  return rules;
}

const files = cssFiles(appDirectory);
const rules = files.flatMap(parseRules);

function ruleIncludesSelector(rule: CssRule, selector: string): boolean {
  return rule.selector.split(",").some((part) => part.trim() === selector);
}

function expectRecipe(selector: string, declarations: Record<string, string>): void {
  const matchingRule = rules.find(
    (rule) =>
      rule.file === "globals.css" &&
      ruleIncludesSelector(rule, selector) &&
      Object.entries(declarations).every(
        ([property, value]) => rule.declarations.get(property) === value,
      ),
  );

  expect(matchingRule, `${selector} must expose the canonical recipe`).toBeDefined();
}

function declarationKey(rule: CssRule, property: string, value: string): string {
  return `${rule.file} :: ${rule.selector} :: ${property}: ${value}`;
}

const semanticShapeAllowlist: AllowedDeclaration[] = [
  {
    file: "globals.css",
    property: "border-radius",
    selector: ".chipChoice label",
    value: "999px",
  },
  {
    file: "globals.css",
    property: "border-radius",
    selector: ".simpleInlineCheck",
    value: "999px",
  },
  {
    file: "globals.css",
    property: "border-radius",
    selector: ".simpleChoice",
    value: "999px",
  },
];

const legacyPrototypeAllowlist: AllowedDeclaration[] = [
  {
    file: "patrimonio/prototipo-extracto/prototype.module.css",
    property: "box-shadow",
    selector:
      ".topbar, .heroPanel, .summaryPanel, .bucketCard, .fixturePanel, .tablePanel",
    value: "0 1px 2px rgba(23, 32, 30, 0.05), 0 10px 30px rgba(23, 32, 30, 0.06)",
  },
  {
    file: "patrimonio/prototipo-extracto/prototype.module.css",
    property: "border-radius",
    selector: ".backLink",
    value: "999px",
  },
  {
    file: "patrimonio/prototipo-extracto/prototype.module.css",
    property: "border-radius",
    selector: ".fixtureMeta span",
    value: "999px",
  },
  {
    file: "patrimonio/prototipo-extracto/prototype.module.css",
    property: "border-radius",
    selector: ".bucketPill",
    value: "999px",
  },
  {
    file: "patrimonio/prototipo-deuda-estado/prototipo-deuda-estado.module.css",
    property: "box-shadow",
    selector: ".panel",
    value: "0 1px 2px rgba(23, 32, 30, 0.05), 0 10px 30px rgba(23, 32, 30, 0.06)",
  },
  {
    file: "patrimonio/prototipo-deuda-estado/prototipo-deuda-estado.module.css",
    property: "border-radius",
    selector: ".badge",
    value: "999px",
  },
  {
    file: "patrimonio/prototipo-deuda-estado/prototipo-deuda-estado.module.css",
    property: "border-radius",
    selector: ".toggle span",
    value: "999px",
  },
];

const declarationAllowlist = [...semanticShapeAllowlist, ...legacyPrototypeAllowlist].map(
  ({ file, property, selector, value }) =>
    `${file} :: ${selector} :: ${property}: ${value}`,
);

describe("Libro mayor design-system guardian (#906)", () => {
  test("pins the canonical root tokens to their approved literals", () => {
    const root = rules.find(
      (rule) => rule.file === "globals.css" && rule.selector === ":root",
    );
    expect(root).toBeDefined();

    const canonicalTokens = {
      "--band": "#eaedde",
      "--blue": "#1f4d74",
      "--cover": "#102420",
      "--cover-2": "#0a1916",
      "--cover-3": "#16302a",
      "--cover-ink": "#ecefe1",
      "--cover-muted": "#9fb0a3",
      "--debit-rule": "#a03a28",
      "--gilt": "#c2a14e",
      "--hairline": "#dde1d0",
      "--ink": "#1c2420",
      "--line-soft": "#c9cfbd",
      "--muted": "#4e5c54",
      "--panel": "#f7f7ee",
      "--paper": "#eef0e4",
      "--radius": "6px",
      "--radius-sm": "4px",
      "--rule-heavy": "2px solid var(--ink)",
    } as const;

    for (const [token, value] of Object.entries(canonicalTokens)) {
      expect(root?.declarations.get(token), token).toBe(value);
    }
  });

  test("exposes the canonical component catalogue as literal recipes", () => {
    expectRecipe(".section", {
      background: "transparent",
      "border-top": "var(--rule-heavy)",
      "box-shadow": "none",
    });
    expectRecipe(".heroPanel", {
      "background-color": "var(--panel)",
      "border-radius": "var(--radius)",
      "box-shadow": "none",
    });
    expectRecipe(".navTab", {
      background: "transparent",
      "border-radius": "0",
      "border-bottom": "2px solid transparent",
    });
    expectRecipe(".segmented", {
      border: "1px solid var(--line)",
      "border-radius": "var(--radius-sm)",
    });
    expectRecipe(".btn", {
      "border-radius": "var(--radius-sm)",
      "font-weight": "650",
    });
    expectRecipe(".totalRule::after", {
      background:
        "linear-gradient(to bottom, var(--ink) 0 1px, transparent 1px 3px, var(--ink) 3px 4px)",
      height: "4px",
    });
    expectRecipe(".debitCol", { "border-left": "2px solid var(--debit-rule)" });
    expectRecipe(".band", { background: "var(--band)" });
    expectRecipe(".coverSurface", {
      "--ink": "var(--cover-ink)",
      "--muted": "var(--cover-muted)",
      "--paper": "var(--cover)",
    });
    expectRecipe(".coverMasthead", {
      background: "var(--cover)",
      "border-bottom": "2px solid var(--gilt)",
      color: "var(--cover-ink)",
    });
    expectRecipe(".sessionBand", {
      background: "var(--band)",
      "border-bottom": "1px solid var(--line)",
      color: "var(--ink)",
    });
  });

  test("rejects deprecated visual vocabulary everywhere", () => {
    const deprecated = [
      "--shadow",
      "--ink-panel",
      "--ink-panel-text",
      "--ink-panel-muted",
      "--pos-on-dark",
      "--neg-on-dark",
    ];
    const hits = files.flatMap((file) => {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return deprecated
        .filter((token) => source.includes(token))
        .map((token) => `${relative(appDirectory, file)} :: ${token}`);
    });

    expect(hits).toEqual([]);
  });

  test("rejects elevation and indiscriminate pills with an exact selector ratchet", () => {
    const violations = rules.flatMap((rule) => {
      const findings: string[] = [];
      const shadow = rule.declarations.get("box-shadow");
      if (shadow && shadow !== "none") {
        const key = declarationKey(rule, "box-shadow", shadow);
        if (!declarationAllowlist.includes(key)) findings.push(key);
      }

      const radius = rule.declarations.get("border-radius");
      if (radius === "999px") {
        const key = declarationKey(rule, "border-radius", radius);
        if (!declarationAllowlist.includes(key)) findings.push(key);
      }
      return findings;
    });

    expect(violations).toEqual([]);
  });

  test("allows one static identity, never a second theme or appearance selector", () => {
    const themeSelectors = rules
      .filter((rule) =>
        /\[data-(?:appearance|theme)|\.(?:dark|light)(?:\b|:)/.test(rule.selector),
      )
      .map((rule) => `${rule.file} :: ${rule.selector}`);
    const dynamicColorSchemes = rules
      .filter((rule) => {
        const value = rule.declarations.get("color-scheme");
        return value !== undefined && value !== "light";
      })
      .map((rule) => `${rule.file} :: ${rule.selector}`);
    const mediaThemes = files
      .filter((file) =>
        /@media\s*\([^)]*prefers-color-scheme/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(appDirectory, file));

    expect({ dynamicColorSchemes, mediaThemes, themeSelectors }).toEqual({
      dynamicColorSchemes: [],
      mediaThemes: [],
      themeSelectors: [],
    });
  });

  test("the Resumen reference surface consumes the canonical primitives", () => {
    const dashboard = readFileSync(join(appDirectory, "dashboard-content.tsx"), "utf8");

    for (const className of [
      "summaryBand heroPanel",
      "emptyDashCta section",
      "liquidityPanel section",
      "historyPanel section",
      "firePanel section",
      "onboardingChecklist section",
    ]) {
      expect(dashboard, className).toContain(`className=\"${className}\"`);
    }
    expect(dashboard).toContain('className={hasHoldings ? "totalRule"');
    expect(dashboard).toContain('className="debitCol"');
  });
});
