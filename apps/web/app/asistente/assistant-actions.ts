import { holdingDetailHref, isPublicHoldingId } from "@web/holding-route";

import { internalProseLinkHref } from "./prose-link";
import type { ScreenSection } from "./screen-context";

/**
 * Typed read-only quick actions and internal-source destinations (#631, ADR
 * 0053/0052). The model may PROPOSE actions, but the app renders only what
 * validates against this small typed set, and navigates only to internal
 * worthline surfaces — the model never hands over a raw URL, so there is no
 * open-redirect or scheme-injection surface. Nothing here mutates data.
 *
 * Pure by design: the chat tool resolves a model's public-id reference to an
 * internal id (needs the store), then these functions decide the destination
 * and the final typed shape — both unit-testable in the node env.
 */

export interface OpenInternalSourceAction {
  type: "openInternalSource";
  label: string;
  /** A resolved INTERNAL path (`/…`). Never a model-supplied URL. */
  href: string;
}

export interface RunSuggestedAnalysisAction {
  type: "runSuggestedAnalysis";
  label: string;
  /** The follow-up prompt to seed into the same open conversation. */
  prompt: string;
}

export type QuickAction = OpenInternalSourceAction | RunSuggestedAnalysisAction;

/** A cited source the tool resolved, before we know if it maps to a surface. */
export type SourceRef =
  | { kind: "holding"; publicId: string }
  | { kind: "section"; section: ScreenSection }
  | { kind: "figure"; figure: string };

/** Cap the chips so a chatty model can't flood the panel. */
export const MAX_ACTIONS = 4;
export const MAX_LABEL = 120;
export const MAX_PROMPT = 280;

/** Product routes per section; `otra` has no single destination. */
const SECTION_ROUTE: Record<ScreenSection, string | null> = {
  resumen: "/app",
  patrimonio: "/patrimonio",
  historico: "/historico",
  objetivos: "/objetivos",
  ajustes: "/ajustes",
  otra: null,
};

/** Which surface owns each explainable figure. */
const FIGURE_SECTION: Record<string, ScreenSection> = {
  net_worth: "patrimonio",
  liquid_net_worth: "patrimonio",
  gross_assets: "patrimonio",
  debts: "patrimonio",
  housing_equity: "patrimonio",
  liquidity_breakdown: "patrimonio",
  holding_value: "patrimonio",
  fire_eligible_assets: "objetivos",
  fire_progress: "objetivos",
};

/**
 * The path a chip may navigate to, or null: rooted at `/`, not protocol-relative
 * (`//`), no backslash tricks, no scheme (`:`). Blocks `javascript:`, `http://…` and
 * `//evil` while allowing `/patrimonio/x/editar`.
 *
 * Returns the CLEANED path and decides on it, never on the raw string (#1407): the
 * URL parser DELETES tabs, LF and CR before resolving, so `/<tab>/evil.test/x` reads
 * as a single-slash path — no backslash, no colon — and then navigates to
 * `https://evil.test/x`. `internalProseLinkHref` strips exactly those characters,
 * which is the same gate a link written in the prose goes through (#1289); the two
 * extra checks here are what the chip channel adds on top of it.
 */
function internalActionHref(href: string): string | null {
  const cleaned = internalProseLinkHref(href);
  return cleaned !== null && !cleaned.includes("\\") && !cleaned.includes(":")
    ? cleaned
    : null;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/**
 * A chip label that promises a write on the portfolio (ADR 0053, #1515).
 *
 * Quick actions are read-only: a label is a destination («Ver…», «Ir a…») or a
 * follow-up question, never an act. The model writes the label in free text, so
 * the first word is the check — «Ir a Importar Extracto» is navigation,
 * «Importar Extracto» is a write. Discard the chip, don't rewrite the label: a
 * rewritten caption would say something the model didn't, and the model may
 * offer up to four, so losing one still leaves a way out.
 */
const WRITE_LABEL_STARTERS = new Set([
  "anota",
  "anotad",
  "anotar",
  "anote",
  "anoten",
  "aplica",
  "aplicad",
  "aplicar",
  "aplique",
  "apliquen",
  "confirma",
  "confirmad",
  "confirmar",
  "confirme",
  "confirmen",
  "corrige",
  "corregid",
  "corregir",
  "corrija",
  "corrijan",
  "ejecuta",
  "ejecutad",
  "ejecutar",
  "ejecute",
  "ejecuten",
  "guarda",
  "guardad",
  "guardar",
  "guarde",
  "guarden",
  "importa",
  "importad",
  "importar",
  "importe",
  "importen",
  "registra",
  "registrad",
  "registrar",
  "registre",
  "registren",
]);

function labelPromisesWrite(label: string): boolean {
  const first = label.trim().split(/\s+/u, 1)[0] ?? "";
  const word = first
    .toLocaleLowerCase("es")
    .replace(/^[«»"'¡¿]+/u, "")
    .replace(/[«»"'.,;:!?]+$/u, "");
  return WRITE_LABEL_STARTERS.has(word);
}

/**
 * Validate model-proposed actions into the typed set, dropping anything outside
 * it or malformed (ADR 0053). Runs on already-server-resolved actions as a
 * final trust boundary before render, and capped.
 */
export function parseQuickActions(raw: unknown): QuickAction[] {
  if (!Array.isArray(raw)) return [];

  const actions: QuickAction[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const label = boundedString(candidate["label"], MAX_LABEL);
    if (label === null || labelPromisesWrite(label)) continue;

    if (candidate["type"] === "openInternalSource") {
      const written = boundedString(candidate["href"], MAX_LABEL);
      const href = written === null ? null : internalActionHref(written);
      if (href !== null) {
        actions.push({ type: "openInternalSource", label, href });
      }
    } else if (candidate["type"] === "runSuggestedAnalysis") {
      const prompt = boundedString(candidate["prompt"], MAX_PROMPT);
      if (prompt !== null) {
        actions.push({ type: "runSuggestedAnalysis", label, prompt });
      }
    }

    if (actions.length === MAX_ACTIONS) break;
  }

  return actions;
}

const SCREEN_SECTIONS = new Set<ScreenSection>([
  "resumen",
  "patrimonio",
  "historico",
  "objetivos",
  "ajustes",
  "otra",
]);

function parseScreenSection(value: unknown): ScreenSection | null {
  return typeof value === "string" && SCREEN_SECTIONS.has(value as ScreenSection)
    ? (value as ScreenSection)
    : null;
}

/**
 * Resolve model-proposed quick actions before the server has turned refs into
 * hrefs — covers the failure mode where the model prints `{"actions":[…]}`
 * in text instead of calling `suggest_actions`.
 */
export function resolveModelQuickActions(raw: unknown): QuickAction[] {
  if (!Array.isArray(raw)) return [];

  const actions: QuickAction[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const label = boundedString(item["label"], MAX_LABEL);
    if (label === null || labelPromisesWrite(label)) continue;

    if (item["type"] === "openInternalSource") {
      const rawHref = boundedString(item["href"], MAX_LABEL);
      const hrefDirect = rawHref === null ? null : internalActionHref(rawHref);
      if (hrefDirect !== null) {
        actions.push({ type: "openInternalSource", label, href: hrefDirect });
      } else {
        const holding = boundedString(item["holding"], MAX_LABEL);
        const section = parseScreenSection(item["section"]);
        const figure = boundedString(item["figure"], MAX_LABEL);
        let resolved: string | null = null;
        if (holding !== null) {
          resolved = sourceHref({ kind: "holding", publicId: holding });
        } else if (section !== null) {
          resolved = sourceHref({ kind: "section", section });
        } else if (figure !== null) {
          resolved = sourceHref({ kind: "figure", figure });
        }
        // Through the same gate as a href written in the text, resolved or not: one
        // place decides what a chip may point at, and `OpenInternalSourceAction.href`
        // being a string is then true by construction rather than by inspection.
        const href = resolved === null ? null : internalActionHref(resolved);
        if (href !== null) {
          actions.push({ type: "openInternalSource", label, href });
        }
      }
    } else if (item["type"] === "runSuggestedAnalysis") {
      const prompt = boundedString(item["prompt"], MAX_PROMPT);
      if (prompt !== null) {
        actions.push({ type: "runSuggestedAnalysis", label, prompt });
      }
    }

    if (actions.length === MAX_ACTIONS) break;
  }

  return actions;
}

/**
 * Strip a trailing `{"actions":[…]}` block from assistant text and recover any
 * typed quick actions the model printed instead of calling `suggest_actions`.
 */
export function extractEmbeddedQuickActions(text: string): {
  cleaned: string;
  actions: QuickAction[];
} {
  const trimmedEnd = text.trimEnd();
  let depth = 0;
  for (let i = trimmedEnd.length - 1; i >= 0; i--) {
    const ch = trimmedEnd[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      depth -= 1;
      if (depth !== 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedEnd.slice(i));
      } catch {
        return { cleaned: text, actions: [] };
      }

      if (!isRecord(parsed) || !Array.isArray(parsed["actions"])) {
        return { cleaned: text, actions: [] };
      }

      const actions = resolveModelQuickActions(parsed["actions"]);
      if (actions.length === 0) return { cleaned: text, actions: [] };

      return { cleaned: trimmedEnd.slice(0, i).trimEnd(), actions };
    }
  }

  return { cleaned: text, actions: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve a cited internal source to its product route, or null if it has none. */
export function sourceHref(ref: SourceRef): string | null {
  switch (ref.kind) {
    case "holding":
      // The public `wl_hld_…` id lands verbatim in the URL — the same id the
      // model reads from every tool, and since #1318 the same one the route
      // takes. (It used to be spliced in as an INTERNAL id, so a chip pointing
      // at a holding built a URL the router never accepted.)
      //
      // The shape check is the cheap half of the guard, and it earns its keep:
      // #1318 records the model INVENTING `asset_fidelity_s_p_500_index_fund_…`
      // after watching the URL bar. A chip is a link the user will click, so an
      // id in the retired vocabulary is dropped here rather than rendered as a
      // guaranteed 404. Slashes are rejected with it, so a miss upstream can
      // never forge extra path segments.
      return isPublicHoldingId(ref.publicId) && !ref.publicId.includes("/")
        ? holdingDetailHref(ref.publicId)
        : null;
    case "section":
      return SECTION_ROUTE[ref.section] ?? null;
    case "figure": {
      // Own properties only, and `?? null` on both lookups (#1407). The figure name
      // comes from the model, and every object inherits `constructor`, `toString` and
      // `hasOwnProperty` from its prototype: a plain `FIGURE_SECTION[ref.figure]`
      // returned the truthy `Object` constructor for «constructor», which then indexed
      // `SECTION_ROUTE` to `undefined` — and `undefined` is not `null`, so it slipped
      // through every `!== null` guard downstream and became a chip with NO href, a
      // `<Link href={undefined}>` that throws while rendering the assistant panel.
      const section = Object.hasOwn(FIGURE_SECTION, ref.figure)
        ? FIGURE_SECTION[ref.figure]
        : undefined;
      return section === undefined ? null : (SECTION_ROUTE[section] ?? null);
    }
  }
}
