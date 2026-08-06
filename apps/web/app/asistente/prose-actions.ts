import {
  MAX_ACTIONS,
  MAX_LABEL,
  MAX_PROMPT,
  type QuickAction,
} from "./assistant-actions";
import { internalProseLinkHref } from "./prose-link";

/**
 * The «Acciones recomendadas:» list the model writes in its own prose, turned into
 * the typed chips the app already renders.
 *
 * The assistant has one sanctioned channel for follow-ups — `suggest_actions`, whose
 * output the app re-validates and paints as buttons (ADR 0053). The model keeps
 * ALSO writing the same list as markdown at the end of the answer, and that copy is
 * strictly worse than the chips: `[Ver detalle](«Colección Numista»)` is not even a
 * link (a markdown destination with spaces needs angle brackets), so it renders as
 * literal brackets, and a follow-up question printed as a bullet is a sentence the
 * reader has to retype instead of a button that sends it.
 *
 * So the prose copy is not made clickable — it is REMOVED and its items become the
 * chips they were describing. That keeps every destination inside the typed set
 * (this module resolves nothing the chip channel cannot already express) and leaves
 * one place where follow-ups live.
 *
 * The REMOVAL is all-or-nothing; the CONVERSION is not (#1375). Half-eaten prose — a
 * heading with one bullet gone — is worse than the duplicate we started with, so a
 * block that goes, goes whole. But an unconvertible item used to keep the whole block
 * in the text, and the real worst case turned out to be exactly that: four turns in a
 * row ending in `• [Abrir detalles del Plan](openInternalSource?holding=«…»)` and a
 * bare `[blocked]`, raw markdown that reads as a broken app rather than as «the
 * assistant had nothing else to offer».
 *
 * So a block goes when it is the model's ACTION LIST: something in it became a chip,
 * or something in it is machinery that leaked (a markdown link, a `[blocked]` tag, the
 * tool's own vocabulary). A heading followed by plain sentences — «Vende el fondo A»,
 * «Revisa tu colchón» — is advice the reader can read, and deleting it would answer
 * broken markdown with a silence. Whatever it is, the user never keeps the debris of
 * an item we could not convert: those leave with their block.
 */

/** `Acciones recomendadas:` / `**Acciones sugeridas**` / `Acciones de seguimiento:` */
const BLOCK_HEADING =
  /^\s*\**\s*acciones\s+(?:recomendadas|sugeridas|de\s+seguimiento)\s*\**\s*:?\s*\**\s*$/i;

/** `- item`, `* item`, `• item`, `1. item`, `2) item`. */
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;

/** A whole-item markdown link: `[label](destination)`. */
const WHOLE_ITEM_LINK = /^\[([^\]]+)\]\(([^)]*)\)$/;

/** Bold or italic wrapping the entire item, which the model likes to add. */
const WRAPPING_EMPHASIS = /^(\*\*|\*|__|_)([\s\S]+)\1$/;

/**
 * A trailing state tag the model annotates its own list with: `… [blocked]`.
 *
 * One bare ASCII word, deliberately. Any bracketed tail would also match a footnote
 * marker (`[1]`), a year (`[2025]`) or an aside a person would write
 * (`[límite 1.500 € anuales]`) — and since one machinery item takes its whole block
 * with it, a footnote would delete four real recommendations.
 */
const ITEM_STATE_TAG = /\[[a-z_]{3,20}\]\s*$/i;

/** The action channel's own vocabulary, which only ever leaks out of machinery. */
const ACTION_VOCABULARY = /openInternalSource|runSuggestedAnalysis|suggest_actions/i;

/** A product path with a holding id spliced into it, which prose never carries. */
const ITEM_HOLDING_PATH = /\/[a-z-]+\/wl_hld_[a-z0-9_]/i;

export interface ProseActionSplit {
  /** The reply with the trailing action block removed, or the original text. */
  cleaned: string;
  /** The chips recovered from that block, in the order they were written. */
  actions: QuickAction[];
}

/**
 * Split a trailing action block off the assistant's prose and recover its items as
 * typed quick actions. `toolActions` are the chips the same turn already produced:
 * a prose item that merely repeats one of them resolves to that chip rather than
 * being dropped — which is what makes the common «heading + a link with a made-up
 * destination + a question» block convertible at all.
 *
 * A block that is recognised always leaves the text, whether or not its items became
 * chips. What is NOT recognised (no heading, a list mid-answer) is left alone: this
 * only ever eats a list the model announced as its follow-up actions.
 */
export function splitProseActionBlock(
  text: string,
  toolActions: readonly QuickAction[] = [],
): ProseActionSplit {
  const unchanged: ProseActionSplit = { cleaned: text, actions: [] };

  const lines = text.trimEnd().split("\n");
  const bodies: string[] = [];
  let headingAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const item = LIST_ITEM.exec(line);
    if (item) {
      bodies.unshift((item[1] ?? "").trim());
      continue;
    }
    if (BLOCK_HEADING.test(line)) headingAt = i;
    break;
  }
  if (headingAt === -1 || bodies.length === 0) return unchanged;

  // Best-effort per item, capped like every other chip path: a chatty block of eight
  // bullets still leaves the text, it just cannot become eight buttons.
  const actions: QuickAction[] = [];
  let machinery = false;
  for (const body of bodies) {
    if (looksLikeMachinery(body)) machinery = true;
    if (actions.length === MAX_ACTIONS) continue;
    const action = proseItemAction(body, toolActions);
    if (action !== null) actions.push(action);
  }
  if (actions.length === 0 && !machinery) return unchanged;

  return { cleaned: lines.slice(0, headingAt).join("\n").trimEnd(), actions };
}

/**
 * Merge the chips recovered from prose with the ones the tool produced, keeping the
 * order the reader saw and dropping the repeats. Capped like every other chip path.
 */
export function mergeQuickActions(
  proseActions: readonly QuickAction[],
  toolActions: readonly QuickAction[],
): QuickAction[] {
  const merged: QuickAction[] = [];
  const seen = new Set<string>();
  for (const action of [...proseActions, ...toolActions]) {
    const key = actionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(action);
    if (merged.length === MAX_ACTIONS) break;
  }
  return merged;
}

/**
 * Is this bullet a piece of the app that leaked into the answer, rather than a
 * sentence written for the reader?
 *
 * Only shapes prose does not have. A bullet that IS a markdown link is a button
 * written by hand; a link INSIDE a sentence («revisa [tu histórico](/historico)
 * antes de aportar») is advice with a working link in it, and deleting that is the
 * one thing worse than the bug being fixed.
 */
function looksLikeMachinery(body: string): boolean {
  const item = withoutWrappingEmphasis(body);
  return (
    WHOLE_ITEM_LINK.test(item) ||
    ITEM_STATE_TAG.test(item) ||
    ACTION_VOCABULARY.test(item) ||
    ITEM_HOLDING_PATH.test(item)
  );
}

/** Identity for de-duplication: the destination, not the wording around it. */
function actionKey(action: QuickAction): string {
  return action.type === "openInternalSource"
    ? `open:${action.href}`
    : `run:${normalized(action.prompt)}`;
}

/**
 * One bullet, or null when it does not map to a typed action.
 *
 * A link resolves by destination when the destination is a real internal path, and
 * otherwise by label against the chips this turn already has — the model's habit is
 * to put the surface's NAME where the URL goes, which resolves to nothing on its
 * own. A plain bullet becomes a follow-up prompt only when it is a question: an
 * imperative («revisa tu liquidez») is advice the model wrote for the reader, not a
 * sentence to send back to itself, and turning it into a button would put words in
 * the user's mouth.
 */
function proseItemAction(
  body: string,
  toolActions: readonly QuickAction[],
): QuickAction | null {
  const item = withoutWrappingEmphasis(body);
  if (item === "") return null;

  const link = WHOLE_ITEM_LINK.exec(item);
  if (link) {
    const label = withoutWrappingEmphasis(link[1] ?? "");
    if (label === "" || label.length > MAX_LABEL) return null;
    const href = internalProseLinkHref((link[2] ?? "").trim());
    if (href !== null && href.length <= MAX_LABEL) {
      return { type: "openInternalSource", label, href };
    }
    return matchingToolAction(label, toolActions);
  }

  if (item.length > MAX_PROMPT || item.length > MAX_LABEL) return null;
  if (item.includes("?"))
    return { type: "runSuggestedAnalysis", label: item, prompt: item };
  return matchingToolAction(item, toolActions);
}

/** The chip this bullet is repeating, matched on its visible label. */
function matchingToolAction(
  label: string,
  toolActions: readonly QuickAction[],
): QuickAction | null {
  const wanted = normalized(label);
  return toolActions.find((action) => normalized(action.label) === wanted) ?? null;
}

function withoutWrappingEmphasis(value: string): string {
  const trimmed = value.trim();
  const emphasised = WRAPPING_EMPHASIS.exec(trimmed);
  return emphasised ? (emphasised[2] ?? "").trim() : trimmed;
}

/** Case- and punctuation-insensitive, so «Ver detalle.» matches «Ver detalle». */
function normalized(value: string): string {
  return value
    .toLocaleLowerCase("es")
    .replace(/[«»"'.,;:!¡]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
