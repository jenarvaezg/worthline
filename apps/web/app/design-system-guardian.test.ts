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
    // The luminous sheet restores the paper tokens .coverSurface shadows; a
    // shadowed custom property cannot be un-shadowed, so these literals must
    // stay in lockstep with the :root pins above.
    expectRecipe(".coverSheet", {
      "--ink": "#1c2420",
      "--muted": "#4e5c54",
      "--paper": "#eef0e4",
      background: "var(--panel)",
      color: "var(--ink)",
    });
    expectRecipe(".sessionBand", {
      background: "var(--band)",
      "border-bottom": "1px solid var(--line)",
      color: "var(--ink)",
    });
    // The honest paywall (#1162) is an aviso opened by a gold left rule — same
    // semantics as .debitCol/.sessionBand[warning], never a card. Pinned so the
    // aviso vocabulary cannot silently drift into a shadowed/pilled panel.
    expectRecipe(".premiumNotice", {
      "border-left": "2px solid var(--gold)",
      "border-radius": "var(--radius-sm)",
    });
  });

  test("every consumed custom property resolves to a real definition (#913)", () => {
    // A var(--x) whose token was renamed or deleted fails silently: the
    // declaration becomes invalid-at-computed-value time and the element
    // renders with no color at all (how «Depósitos»/«Europa» went blank on
    // the landing when the local cover tokens were consolidated into
    // globals.css). Tokens may be defined in CSS declarations or injected
    // from TSX (inline style keys, next/font `variable:`) — both count.
    const sourceFiles = (function walk(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return walk(path);
        if (!entry.isFile()) return [];
        return /\.(?:css|tsx?)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
          ? [path]
          : [];
      });
    })(appDirectory);

    const defined = new Set<string>();
    const used = new Map<string, Set<string>>();

    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      if (file.endsWith(".css")) {
        for (const match of source.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)) {
          defined.add(match[1]!);
        }
      } else {
        // Inline style keys ({ "--dot": … }) and next/font variable names.
        for (const match of source.matchAll(/"(--[a-zA-Z][\w-]*)"/g)) {
          defined.add(match[1]!);
        }
      }
      // The [,)] terminator skips dynamic names (`var(--tier-${id})`), which
      // cannot be checked statically.
      for (const match of source.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)\s*[,)]/g)) {
        const name = match[1]!;
        const seats = used.get(name) ?? new Set<string>();
        seats.add(relative(appDirectory, file));
        used.set(name, seats);
      }
    }

    const orphans = [...used.entries()]
      .filter(([name]) => !defined.has(name))
      .map(([name, seats]) => `${name} :: ${[...seats].sort().join(", ")}`)
      .sort();

    expect(orphans).toEqual([]);
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

  test("the threshold and closing surfaces consume the cover register (#909)", () => {
    const expectations: Array<[file: string, needle: string]> = [
      ["login/page.tsx", 'className="loginPage coverSurface"'],
      ["login/page.tsx", 'className="loginCard coverSheet"'],
      ["demo/page.tsx", 'className="demoCover coverSurface"'],
      ["demo/page.tsx", 'className="demoPersonaCard coverSheet"'],
      ["not-found.tsx", 'className="notFoundPage coverSurface"'],
      ["shell.tsx", 'className="persistenceBar coverSurface"'],
      ["empezar/page.tsx", 'className="coverSurface coverMasthead empezarMasthead"'],
    ];

    for (const [file, needle] of expectations) {
      const source = readFileSync(join(appDirectory, file), "utf8");
      expect(source, `${file} must contain ${needle}`).toContain(needle);
    }
  });

  test("the shell masthead is paper, not a filled panel (#910)", () => {
    // Canon §3: the hero is the only surface with a fill; the masthead is paper
    // opened by a heavy rule, never a card. (.topbar also carries a
    // view-transition anchor rule, so match on the recipe, not the first rule.)
    expectRecipe(".topbar", {
      background: "transparent",
      "border-bottom": "var(--rule-heavy)",
    });

    // The scope selector is a segmented control (canon §5), not outline pills:
    // square segments divided by a rule, active inverts to ink.
    const scopeBtn = rules.find(
      (rule) => rule.file === "globals.css" && rule.selector === ".scopeTabBtn",
    );
    expect(scopeBtn?.declarations.get("border-radius")).toBe("0");
    expect(scopeBtn?.declarations.get("border-left")).toBe("1px solid var(--line)");
  });

  test("the shell and root layers consume the paper register (#910)", () => {
    const expectations: Array<[file: string, needle: string]> = [
      // Register tabs (navTab) for the section nav; scope selector segmented.
      ["shell.tsx", "className={`navTab${"],
      ["shell.tsx", 'className="scopeTabs segmented"'],
      // Session bands (not cover, not cards): demo neutral, impersonation caution.
      ["demo/demo-banner.tsx", 'className="sessionBand"'],
      ["admin/impersonation-banner.tsx", 'className="sessionBand"'],
      ["admin/impersonation-banner.tsx", 'data-tone="warning"'],
      // Runtime error boundary stays on paper with a system error band.
      ["error.tsx", 'className="errorBand"'],
    ];

    for (const [file, needle] of expectations) {
      const source = readFileSync(join(appDirectory, file), "utf8");
      expect(source, `${file} must contain ${needle}`).toContain(needle);
    }

    // The recoverable error boundary must not fall back to the panel card.
    const errorSource = readFileSync(join(appDirectory, "error.tsx"), "utf8");
    expect(errorSource).not.toContain("summaryBand");
  });

  test("the assistant layer is recipe'd on paper, not as cards (#911)", () => {
    const assistantRule = (selector: string): CssRule | undefined =>
      rules.find((rule) => rule.file === "globals.css" && rule.selector === selector);

    // The launcher is a register marker (square, radius-sm), never a floating
    // circle — canon §5 forbids pills/circles by inertia.
    const fab = assistantRule(".assistantFab");
    expect(fab?.declarations.get("border-radius")).toBe("var(--radius-sm)");
    expect(fab?.declarations.get("box-shadow")).toBe("none");

    // The panel is an inserted sheet bound to the page by a heavy rule (its
    // spine), with no elevation shadow — not a card floating over the page.
    // (assistantRule returns the base rule; the @media bottom-sheet override
    // that resets border-left comes later in document order.)
    const panel = assistantRule(".assistantPanel");
    expect(panel?.declarations.get("border-left")).toBe("var(--rule-heavy)");
    expect(panel?.declarations.get("box-shadow")).toBe("none");

    // The panel masthead is paper opened by a heavy rule, like the shell (#910).
    expect(assistantRule(".assistantHead")?.declarations.get("border-bottom")).toBe(
      "var(--rule-heavy)",
    );

    // Proposals and the attachment reading are paper entries opened by a heavy
    // rule — the slice's core demand: "sin heredar tarjeta". No perimeter
    // border, no radius, no paper fill.
    for (const selector of [".assistantProposal", ".assistantAttachmentPreview"]) {
      const entry = assistantRule(selector);
      expect(entry?.declarations.get("border-top"), selector).toBe("var(--rule-heavy)");
      expect(entry?.declarations.get("border"), selector).toBeUndefined();
      expect(entry?.declarations.get("border-radius"), selector).toBeUndefined();
      expect(entry?.declarations.get("background"), selector).toBeUndefined();
    }

    // The user turn is a ledger entry with a marginalia rule, not a chat bubble.
    const userTurn = assistantRule(".assistantMsg.user p");
    expect(userTurn?.declarations.get("border-left")).toBe(
      "2px solid var(--line-strong)",
    );
    expect(userTurn?.declarations.get("border-radius")).toBeUndefined();
    expect(userTurn?.declarations.get("background")).toBeUndefined();
  });

  test("the assistant surface consumes the paper register in markup (#911)", () => {
    const layer = readFileSync(
      join(appDirectory, "asistente/assistant-layer.tsx"),
      "utf8",
    );
    // Each proposal states its kind through the shared folio label (the first
    // real child is the srOnly mutation status, so the title carries its class).
    // Nine cards: statement, correction (#1051), reconstruction (#1053),
    // balance-history, valuation, mixed, holding-creation (#1105), the shared
    // baja/restauración card (#1106, one card, two folios), and reconcile (#1108).
    const kindTitles = layer.match(/className="assistantProposalKind"/g) ?? [];
    expect(kindTitles.length).toBe(9);
  });

  test("the settings recipes trade card elevation for paper rules (#912)", () => {
    // Canon §4: only the hero carries a fill — the settings panels are open
    // sections opened by a heavy rule, not filled/bordered/rounded cards.
    const panel = rules.find(
      (rule) => rule.file === "globals.css" && rule.selector === ".ajustesPanel",
    );
    expect(panel?.declarations.get("background")).toBeUndefined();
    expect(panel?.declarations.get("border")).toBeUndefined();
    expect(panel?.declarations.get("border-radius")).toBeUndefined();
    expect(panel?.declarations.get("box-shadow")).toBeUndefined();

    // The connected-source tile (Numista/Binance) — shared with the holding
    // editor — is a ruled ledger entry opened by a heavy rule, never a nested
    // card: no fill, no perimeter border, no radius.
    const tile = rules.find(
      (rule) => rule.file === "globals.css" && rule.selector === ".coinSourceTile",
    );
    expect(tile?.declarations.get("border-top")).toBe("var(--rule-heavy)");
    expect(tile?.declarations.get("box-shadow")).toBe("none");
    expect(tile?.declarations.get("background")).toBeUndefined();
    expect(tile?.declarations.get("border")).toBeUndefined();
    expect(tile?.declarations.get("border-radius")).toBeUndefined();

    // Warning-override rows read as a ruled list — each opened by a hairline,
    // not a perimeter border box.
    const override = rules.find(
      (rule) => rule.file === "globals.css" && rule.selector === ".overrideRow",
    );
    expect(override?.declarations.get("border-top")).toBe("1px solid var(--line-soft)");
    expect(override?.declarations.get("border")).toBeUndefined();
  });

  test("the settings and admin surfaces consume the paper register (#912)", () => {
    // Every settings panel carries the shared .section primitive (paper, not
    // a card). The count pins the sweep — new panels must opt in too.
    const ajustes = readFileSync(join(appDirectory, "ajustes/page.tsx"), "utf8");
    const sectioned = ajustes.match(/className="ajustesPanel section"/g) ?? [];
    expect(sectioned.length).toBe(7);

    // Admin is an interior tool on paper (canon §2): the list sits inside a
    // section and never borrows the cover register.
    const admin = readFileSync(join(appDirectory, "admin/page.tsx"), "utf8");
    expect(admin).toContain('className="adminList section"');
    expect(admin).not.toContain("coverSurface");
  });
});
