/**
 * An identifier that reaches a write came out of a read (#1263).
 *
 * Observed in production and then reproduced twice by the admission gate: the
 * assistant announced a holding id «he verificado los datos», gave a different one
 * in the next turn, and called a write tool with
 * `wl_hld_mortgage_id_placeholder_need_to_find_it` — its own internal monologue
 * inside the identifier field. An id is a fact, and the most consequential kind:
 * it says WHICH thing in the user's patrimony a proposal is about.
 *
 * Why this is code and not a prompt rule (ADR 0067): the server knows for certain
 * which reads ran in the turn and what they returned, so «every id a write points at
 * appeared in a read» is an invariant, not a hope. A better model would only lower
 * the frequency of the invention, and the frontier would still be missing.
 *
 * Two sources ground an id, and both are worthline's own output:
 *  - the reads of THIS turn, recorded as they answer (`chat-tools.ts`);
 *  - the tool outputs still in the conversation the model gets back, which the
 *    route seeds from the history it is about to send.
 * The model's own prose is deliberately NOT a source: a fabricated id printed last
 * turn would otherwise ground itself. The cost is a turn where the assistant has to
 * read again before it can propose, which is the honest order anyway.
 *
 * What this does NOT do: decide whether the id is the RIGHT holding among several.
 * That is a failure of judgement, no server-side invariant can catch it, and it is
 * written down as one of the two things that would make routing by model worth it.
 */

import { isToolUIPart, type ToolSet, type UIMessage } from "ai";

import { publicHoldingIdsIn } from "./public-holding-id";
import { isProposalToolName } from "./tool-parts";

/**
 * The tools whose holding references must be grounded: everything that prepares a
 * write, plus the maintainer alert.
 *
 * The alert is not a proposal and writes nothing to the workspace, but it is filed
 * AGAINST a holding in the control plane (#1050): keyed to an id that does not
 * exist, it carries no forensic value and would arrive as noise in the very inbox
 * that exists to catch calculation bugs. Reads stay out — an unknown id there
 * answers `not_found` on its own, which is how a model finds out it was wrong.
 */
export function requiresGroundedHoldingIds(toolName: string): boolean {
  return isProposalToolName(toolName) || toolName === "raise_maintainer_alert";
}

/**
 * Id-shaped fields that do NOT name a holding. `proposalId` is worthline's own
 * handle for a draft the model is accumulating into (`propose_statement_import`),
 * minted by a previous proposal rather than by a read.
 */
const NON_HOLDING_ID_FIELDS = new Set(["proposalId"]);

/**
 * Does this key name a holding reference? `holdingId`, `holdingIds`, `liabilityId`,
 * `assetId` today. The camelCase boundary is part of the pattern on purpose: a
 * case-insensitive `id$` also matches ordinary words like `valid`.
 */
function isHoldingReferenceKey(key: string): boolean {
  return /(^ids?|Ids?)$/.test(key) && !NON_HOLDING_ID_FIELDS.has(key);
}

/**
 * Every holding a tool input points at, deduplicated in first-seen order.
 *
 * The walk is deep because a reference does not have to be top-level:
 * `propose_mixed_document_import` carries a `liabilityId` and an `assetId` inside
 * each segment. It reads FIELDS, never free text — an id mentioned in a `summary`
 * or sitting inside a pasted `rawText` is prose, and rejecting a whole import over
 * a string in a document is a cost with no safety behind it.
 *
 * Values are taken as written, whatever they look like: a malformed id, a holding's
 * name passed where its id belongs, or an empty-ish string all fail to be grounded,
 * which is the same answer for the same reason. Blanks are the exception — a missing
 * argument is a schema failure the builders already report, and it is not something
 * the model laundered.
 */
export function holdingReferencesIn(input: unknown): string[] {
  const found: string[] = [];
  collectReferences(input, found, new WeakSet());
  return [...new Set(found)];
}

function collectReferences(value: unknown, into: string[], seen: WeakSet<object>): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into, seen);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isHoldingReferenceKey(key)) {
      for (const reference of [nested].flat()) {
        if (typeof reference === "string" && reference.trim().length > 0) {
          into.push(reference);
        }
      }
      continue;
    }
    collectReferences(nested, into, seen);
  }
}

/** The ids worthline has actually surfaced in this conversation. */
export interface GroundedHoldingIds {
  /** Records the ids in one tool answer. Only worthline's own output belongs here. */
  record: (readOutput: unknown) => void;
  has: (id: string) => boolean;
}

/**
 * The turn's ledger of grounded ids, seeded with what the conversation already
 * surfaced.
 *
 * Mutable by design, like the unvalidated-evidence budget next to it:
 * `createChatTools` runs once per turn, so a read in the first step grounds the
 * write in the third.
 */
export function createGroundedHoldingIds(
  seed: Iterable<string> = [],
): GroundedHoldingIds {
  const grounded = new Set(seed);
  return {
    record: (readOutput) => {
      for (const id of publicHoldingIdsIn(readOutput)) grounded.add(id);
    },
    has: (id) => grounded.has(id),
  };
}

/** The references a tool input points at that no read ever surfaced. */
export function ungroundedHoldingIds(
  input: unknown,
  grounded: GroundedHoldingIds,
): string[] {
  return holdingReferencesIn(input).filter((reference) => !grounded.has(reference));
}

/**
 * The ids the model can legitimately use next turn: everything worthline's own tool
 * answers put in the history it is about to be sent.
 *
 * Tool OUTPUTS only, never a tool input and never prose. A proposal's output counts
 * — it is built by the server after the id resolved, so it is worthline asserting
 * the holding exists — and leaving it out would reject the ordinary «cámbiale el
 * importe» follow-up on a card the user is looking at.
 */
export function groundedHoldingIdsInHistory(messages: readonly UIMessage[]): string[] {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          isToolUIPart(part) && "output" in part ? publicHoldingIdsIn(part.output) : [],
        ),
      ),
    ),
  ];
}

/**
 * What the model gets back instead of a proposal.
 *
 * Written to survive being relayed verbatim: it names no tool (the prompt forbids
 * printing tool names) and it accuses nobody — it states what is missing and what to
 * do about it. The last sentence is the other half of #1263: an id is machinery, so
 * the user hears the holding's NAME.
 */
export const UNGROUNDED_HOLDING_ID_MESSAGE =
  "Ese identificador de holding no ha salido de ninguna consulta, ni en este mensaje ni " +
  "en la conversación, así que no preparo la propuesta: un identificador solo puede venir " +
  "de una lectura del patrimonio. Vuelve a consultar la foto financiera del scope o el " +
  "detalle del holding y usa el identificador que te devuelva. Al usuario nómbrale el " +
  "holding por su nombre, nunca por su identificador.";

/** The typed envelope, sibling of the unvalidated-evidence and paywall errors. */
export interface UngroundedHoldingIdError {
  error: "ungrounded_holding_id";
  message: string;
  /** The offending references, so the report says WHAT was rejected. */
  ungroundedHoldingIds: string[];
}

export function ungroundedHoldingIdRejected(
  ungrounded: readonly string[],
): UngroundedHoldingIdError {
  return {
    error: "ungrounded_holding_id",
    message: UNGROUNDED_HOLDING_ID_MESSAGE,
    ungroundedHoldingIds: [...ungrounded],
  };
}

/**
 * Both halves of the invariant applied to a whole tool set, in ONE place: a read
 * grounds the ids it answers, a write is refused the ids nothing grounded.
 *
 * Wrapping the set rather than each `execute` is what makes this a boundary. A
 * proposal tool added in a later slice is guarded the day it is named, and a new read
 * grounds what it surfaces without anyone remembering to wire it — the two rules
 * cannot drift apart because they are the same pass. The check runs BEFORE the
 * tool's own body, so an ungrounded write never reaches the store, never spends the
 * turn's unvalidated-evidence slot, and never dies inside id resolution with an
 * internal error the user has to read.
 */
export function withHoldingIdProvenance(
  tools: ToolSet,
  grounded: GroundedHoldingIds,
  onRejected?: (rejection: { tool: string; ungroundedHoldingIds: string[] }) => void,
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      // The SDK types a tool's `execute` against ITS own input and output; a wrapper
      // that must be agnostic about both cannot be written in those terms, so the
      // loose signature is confined to these two lines.
      const execute = tool.execute as ToolExecute | undefined;
      if (!execute) return [name, tool];
      const wrapped: ToolExecute = requiresGroundedHoldingIds(name)
        ? (input, options) => {
            const ungrounded = ungroundedHoldingIds(input, grounded);
            if (ungrounded.length === 0) return execute(input, options);
            onRejected?.({ tool: name, ungroundedHoldingIds: ungrounded });
            return ungroundedHoldingIdRejected(ungrounded);
          }
        : async (input, options) => {
            const output = await execute(input, options);
            grounded.record(output);
            return output;
          };
      return [name, { ...tool, execute: wrapped }];
    }),
  );
}

type ToolExecute = (input: unknown, options: unknown) => unknown;
