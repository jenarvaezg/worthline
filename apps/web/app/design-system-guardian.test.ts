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

/** Every source file under `app/` whose name matches — one walk, three readers. */
function sourceFiles(pattern: RegExp): string[] {
  return (function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && pattern.test(entry.name) ? [path] : [];
    });
  })(appDirectory);
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
    file: "(workspace)/patrimonio/prototipo-extracto/prototype.module.css",
    property: "box-shadow",
    selector:
      ".topbar, .heroPanel, .summaryPanel, .bucketCard, .fixturePanel, .tablePanel",
    value: "0 1px 2px rgba(23, 32, 30, 0.05), 0 10px 30px rgba(23, 32, 30, 0.06)",
  },
  {
    file: "(workspace)/patrimonio/prototipo-extracto/prototype.module.css",
    property: "border-radius",
    selector: ".backLink",
    value: "999px",
  },
  {
    file: "(workspace)/patrimonio/prototipo-extracto/prototype.module.css",
    property: "border-radius",
    selector: ".fixtureMeta span",
    value: "999px",
  },
  {
    file: "(workspace)/patrimonio/prototipo-extracto/prototype.module.css",
    property: "border-radius",
    selector: ".bucketPill",
    value: "999px",
  },
  {
    file: "(workspace)/patrimonio/prototipo-deuda-estado/prototipo-deuda-estado.module.css",
    property: "box-shadow",
    selector: ".panel",
    value: "0 1px 2px rgba(23, 32, 30, 0.05), 0 10px 30px rgba(23, 32, 30, 0.06)",
  },
  {
    file: "(workspace)/patrimonio/prototipo-deuda-estado/prototipo-deuda-estado.module.css",
    property: "border-radius",
    selector: ".badge",
    value: "999px",
  },
  {
    file: "(workspace)/patrimonio/prototipo-deuda-estado/prototipo-deuda-estado.module.css",
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
    const defined = new Set<string>();
    const used = new Map<string, Set<string>>();

    for (const file of sourceFiles(/^(?!.*\.test\.tsx?$).*\.(?:css|tsx?)$/)) {
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
      ["workspace-footer.tsx", 'className="persistenceBar coverSurface"'],
      ["empezar/page.tsx", 'className="coverSurface coverMasthead empezarMasthead"'],
      // Los textos legales (#1172) son remate público, no trabajo: cubierta
      // fuera, hoja luminosa para el cuerpo del documento.
      ["legal/layout.tsx", 'className="legalPage coverSurface"'],
      ["legal/legal-page.tsx", 'className="legalSheet coverSheet"'],
      ["workspace-legal-footer.tsx", 'className="legalBar coverSurface"'],
    ];

    for (const [file, needle] of expectations) {
      const source = readFileSync(join(appDirectory, file), "utf8");
      expect(source, `${file} must contain ${needle}`).toContain(needle);
    }
  });

  test("the shell masthead is paper, not a filled panel (#910)", () => {
    // Canon §3: the hero is the only surface with a fill; the masthead is paper
    // opened by a heavy rule, never a card. (Match on the recipe, not the first
    // rule — .topbar may pick up further rules elsewhere in the sheet.)
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
      ["section-nav.tsx", "className={`navTab${"],
      ["workspace-scope-bar.tsx", 'className="scopeTabs segmented"'],
      // Session bands (not cover, not cards): demo neutral, impersonation caution.
      ["demo/demo-banner.tsx", 'className="sessionBand"'],
      // La banda de impersonación se pinta en su isla desde #1732 (lo que dice
      // depende de la ruta que tiene debajo); el registro sigue siendo el mismo.
      ["admin/impersonation-band.tsx", 'className="sessionBand"'],
      ["admin/impersonation-band.tsx", 'data-tone="warning"'],
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
    for (const selector of [
      ".assistantProposal",
      ".assistantAttachmentPreview",
      // The app contradicting a faked proposal ceremony (#1262) is set apart the
      // same way, so it cannot drift into a card either.
      ".assistantFakeProposal",
      // And the app denying an incident nobody filed (#1525), the same kind of
      // sentence in the lane that paints no card at all.
      ".assistantFakeAlert",
      // And so is the evidence gate speaking for itself (#1418), in both its moments:
      // the door shutting, and a series worthline could not read.
      ".assistantGateNotice",
      ".assistantSeriesNotice",
      // The provenance mark (#1257) takes over the heavy rule of the proposal it
      // stamps, so stamp and card are ONE paper entry — and neither becomes a card.
      ".assistantProposalOrigin",
    ]) {
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
    // The markup lives in the cards, one module per proposal kind (#1589, ADR
    // 0088), so the register is counted over the whole card directory — and the
    // shell is asserted to hold none of it below.
    const cardsDirectory = join(appDirectory, "asistente/proposal-cards");
    const cards = readdirSync(cardsDirectory)
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => readFileSync(join(cardsDirectory, name), "utf8"))
      .join("\n");
    const layer = readFileSync(
      join(appDirectory, "asistente/assistant-layer.tsx"),
      "utf8",
    );
    // Each proposal states its kind through the shared folio label (the first
    // real child is the srOnly mutation status, so the title carries its class).
    // Thirteen cards: statement, correction (#1051), reconstruction (#1053),
    // balance-history, valuation, mixed, holding-creation (#1105), the shared
    // baja/restauración card (#1106, one card, two folios), reconcile (#1108),
    // early repayment (#1245), the dated investment operation (#1374), the
    // dictated traspaso (#1482) and the property acquisition (#1563).
    const kindTitles = cards.match(/className="assistantProposalKind"/g) ?? [];
    expect(kindTitles.length).toBe(13);

    // The shell is the composer, the conversation and the transport — nothing
    // else (#1589). A card's markup appearing here is how the split unravels:
    // the twelfth card was added by editing the file every card already edited.
    expect(layer).not.toMatch(/className="assistantProposal(Kind|Folio|Actions)?"/);

    // The ledger FOOTER is a different line from the folio label above (canon §3):
    // the atomic-batch statement («1 propuesta · 1 holding · 1 lote atómico»), which
    // only the six atomic cards print — correction, reconstruction, early repayment,
    // the dated operation (#1374, «1 propuesta · 1 posición · 1 operación
    // fechada»), the traspaso (#1482, «1 propuesta · 1 traspaso · 2 apuntes
    // atados» — atomic in the strongest sense there is here: both halves or
    // neither) and the acquisition (#1563, «1 propuesta · 1 inmueble · 1 fecha de
    // adquisición»: one anchor moved and its ripple, in one transaction). The
    // alta, baja and reconcile cards used to print their own kind
    // string there instead, so the reader met the same words twice in one card
    // (#1317). A footer that merely repeats the header is the mistake this pins.
    const footers = cards.match(/className="assistantProposalFolio"/g) ?? [];
    expect(footers.length).toBe(6);
  });

  test("a marked chip carries a binary mark, not only a tint (#1483)", () => {
    // Un tinte (`rgba(...)` + borde) no se lee en un móvil con luz: dos lectores
    // seguidos creyeron que sus ETFs consumían el cupo de pensiones mirando una
    // lista de candidatos SIN marcar. La marca es una casilla dibujada, y su ✓
    // EXISTE solo estando marcada — nunca pintado y escondido con color, que en
    // alto contraste lo devolvería justo al revés.
    expectRecipe(".chipChoice .chipMark", {
      border: "1px solid var(--line-strong)",
    });
    expectRecipe(".chipChoice label:has(input:checked) .chipMark", {
      background: "var(--tier-cash)",
      "border-color": "var(--tier-cash)",
      color: "var(--paper)",
    });
    expectRecipe(".chipChoice label:has(input:checked) .chipMark::before", {
      content: '"✓"',
    });
    // El input va oculto (`opacity: 0`), así que el foco solo se ve si lo pinta
    // el chip — canon §5: todos los controles mantienen teclado.
    expectRecipe(".chipChoice label:has(input:focus-visible)", {
      outline: "2px solid var(--blue)",
    });

    // Y el chip es del canon, no de un uso: `.chipChoice` se pinta en UN sitio,
    // el componente compartido. Cuatro copias a mano fue como el defecto llegó a
    // existir dos veces en el mismo panel.
    const painters = sourceFiles(/\.tsx$/)
      .filter((file) => readFileSync(file, "utf8").includes('className="chipChoice"'))
      .map((file) => relative(appDirectory, file));

    expect(painters).toEqual(["chip-choice.tsx"]);
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
    const ajustes = readFileSync(
      join(appDirectory, "(workspace)/ajustes/page.tsx"),
      "utf8",
    );
    const sectioned = ajustes.match(/className="ajustesPanel section"/g) ?? [];
    // 5 desde #1450: la configuración FIRE se mudó entera a /objetivos, y con ella
    // el puntero al CRUD de objetivos que quedaba de la mudanza de #511.
    expect(sectioned.length).toBe(5);

    // Admin is an interior tool on paper (canon §2): the list sits inside a
    // section and never borrows the cover register.
    const admin = readFileSync(join(appDirectory, "admin/page.tsx"), "utf8");
    expect(admin).toContain('className="adminList section"');
    expect(admin).not.toContain("coverSurface");
  });

  test("prose keeps a reading measure and never goes uppercase (#1732)", () => {
    // Un párrafo tendido sobre los 1180 px del shell pierde el renglón. El tope
    // va en el elemento que lleva la prosa, no en la lista de páginas donde
    // alguien la encontró larga (esa lista se queda corta cada vez).
    expectRecipe("p.muted", { "max-width": "72ch" });
    expectRecipe(".infoNote", { "max-width": "72ch" });

    // `.contextLabel` es caja alta con tracking: un label pequeño real (canon
    // §3). Vestir con él un PÁRRAFO convierte una explicación entera en un
    // rótulo gritado — que es como «Cargar movimientos» y «Corregir precio de un
    // día» describían mientras el resto del producto usaba cursiva normal.
    const shouting = sourceFiles(/\.tsx$/)
      .filter((file) =>
        /<p[^>]*className=(?:"contextLabel"|\{[^}]*"contextLabel")/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => relative(appDirectory, file));

    expect(shouting).toEqual([]);
  });

  test("a section's habitual action is the only one filled with ink (#1732)", () => {
    // Canon §5: primario = tinta sobre hoja; secundario = transparente con
    // --line-strong. El secundario faltaba como receta, así que TODO botón salía
    // primario y la ficha de un activo apilaba ocho negros idénticos.
    expectRecipe(".btnSecondary", {
      background: "transparent",
      "border-color": "var(--line-strong)",
      color: "var(--ink)",
    });
    // El suelo global tiñe de tinta el `:disabled:hover`; un secundario apagado
    // sigue siendo secundario.
    expectRecipe(".btnSecondary:disabled:hover", { background: "transparent" });

    // Y las utilidades de la ficha lo consumen: previsualizar no compite con
    // confirmar, ni rellenar un campo con escribir el libro.
    const surfaces = join(appDirectory, "(workspace)/patrimonio/[id]/editar/_surfaces");
    for (const file of [
      "statement-upload-section.tsx",
      "price-backfill-section.tsx",
      "snapshot-price-correction-section.tsx",
    ]) {
      expect(readFileSync(join(surfaces, file), "utf8"), file).toContain(
        'className="btnSecondary"',
      );
    }
  });

  test("a long holding name truncates instead of crushing its amount (#1732)", () => {
    // La receta ya existía para el nombre de una cartera y el de cada posición
    // dentro de ella; lo que faltaba era la fila suelta, que es donde vive un
    // «Vanguard Global Stock Index Fund EUR Acc».
    for (const selector of [
      ".balanceRowLabel",
      ".balanceGroupMemberName",
      ".catalogName",
    ]) {
      expectRecipe(selector, {
        overflow: "hidden",
        "text-overflow": "ellipsis",
        "white-space": "nowrap",
      });
    }

    // Truncar sin guardar el nombre completo lo pierde: el `title` es el tooltip.
    const row = readFileSync(
      join(appDirectory, "(workspace)/patrimonio/_board/holding-row.tsx"),
      "utf8",
    );
    expect(row).toContain('className="balanceRowLabel" href={detailHref} title={h.name}');
  });

  test("every page container reserves the launcher's footprint on mobile (#1732)", () => {
    // El marcador de registro no se mueve (canon §5, vive en esa esquina): lo
    // que se reserva es el papel que tiene debajo, o se monta sobre la última
    // fila del tablero — su importe y su menú «⋯».
    const fab = rules.find(
      (rule) => rule.file === "globals.css" && rule.selector === ".assistantFab",
    );
    const height = Number.parseInt(fab?.declarations.get("height") ?? "0", 10);
    const bottom = Number.parseInt(fab?.declarations.get("bottom") ?? "0", 10);
    const root = rules.find(
      (rule) => rule.file === "globals.css" && rule.selector === ":root",
    );
    const clearance = Number.parseInt(
      root?.declarations.get("--fab-clearance") ?? "0",
      10,
    );

    // El hueco reservado cubre de verdad lo que el marcador ocupa.
    expect(clearance).toBeGreaterThanOrEqual(height + bottom);

    // Y lo reserva TODO contenedor de página donde el lanzador se monta, que es
    // cualquiera con sesión abierta: `AssistantMount` solo lo calla para el
    // visitante deslogueado, así que la única exención es la del login. Sin esta
    // comprobación la lista se queda corta en silencio la próxima vez que nazca
    // una superficie.
    const reserving = new Set(
      rules
        .filter(
          (rule) =>
            rule.file === "globals.css" &&
            (rule.declarations.get("padding-bottom") === "var(--fab-clearance)" ||
              rule.declarations.get("padding")?.includes("var(--fab-clearance)")),
        )
        .flatMap((rule) => rule.selector.split(",").map((part) => part.trim())),
    );

    const loggedOutOnly = new Set([".loginPage"]);
    const containers = new Set(
      sourceFiles(/\.tsx$/).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/<main className="([^"{]+)"/g)].map(
          (match) => `.${match[1]!.trim().split(/\s+/)[0]}`,
        ),
      ),
    );

    for (const container of containers) {
      if (loggedOutOnly.has(container)) continue;
      expect(reserving.has(container), `${container} must reserve --fab-clearance`).toBe(
        true,
      );
    }
  });
});
