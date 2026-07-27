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
 * All-or-nothing by design: an item we cannot convert leaves the whole block in the
 * text untouched. Half-eaten prose — a heading with one bullet gone — is worse than
 * the duplicate we started with, and «we didn't understand it» must never look like
 * «the assistant had nothing else to offer».
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
  if (headingAt === -1 || bodies.length === 0 || bodies.length > MAX_ACTIONS) {
    return unchanged;
  }

  const actions: QuickAction[] = [];
  for (const body of bodies) {
    const action = proseItemAction(body, toolActions);
    if (action === null) return unchanged;
    actions.push(action);
  }

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
