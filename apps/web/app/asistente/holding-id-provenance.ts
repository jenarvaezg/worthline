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
 * Two sources ground an id:
 *  - the reads of THIS turn, recorded as they answer;
 *  - the tool answers still in the conversation the model gets back, which the route
 *    seeds from the history it is about to send.
 * Neither includes the model's own words. Its prose is not a source (a fabricated id
 * printed last turn would ground itself), nor is a tool INPUT, nor an error envelope
 * — an error can quote back what it was given — nor `suggest_actions`, whose output
 * is the model's own follow-up text handed back. See {@link assertsHoldingIds}: only
 * a tool asserting a workspace fact grounds anything. The cost is a turn where the
 * assistant has to read again before it can propose, which is the honest order.
 *
 * The honest limit of «server-side»: the history arrives in the request, because chat
 * messages are ephemeral by design (ADR 0044) and the browser re-sends them. So a
 * crafted request can pre-ground an id — of its OWN workspace, since resolution is
 * scoped and every builder resolves before writing, which is the same reach the user
 * already has in the UI. What this closes is the failure #1263 is about: the MODEL
 * cannot conjure an identifier out of nothing.
 *
 * What it does NOT do: decide whether the id is the RIGHT holding among several. That
 * is a failure of judgement, no server-side invariant can catch it, and it is written
 * down as one of the two things that would make routing by model worth it (ADR 0067).
 */

import type { ToolSet, UIMessage } from "ai";

import { publicHoldingIdsIn } from "./public-holding-id";
import { isProposalToolName, toolOutputsIn } from "./tool-parts";
import { walkDeep } from "./walk-deep";

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
 * The fields that name a holding, enumerated rather than matched by pattern.
 *
 * A pattern was the first attempt and it was wrong: every `*Id` key read as a holding
 * reference, so `propose_correction`'s `correction.ownership[].memberId` — a
 * `wl_mbr_…`, which no holding read can ever ground — refused every ownership edit
 * with a message about holdings. Enumerating is also how the sibling boundary declares
 * itself (`UNVALIDATED_EVIDENCE_CLASSES`, #1248), and for the same reason: a list a
 * new tool has to join, guarded by a test that reads the tool schemas.
 */
export const HOLDING_REFERENCE_FIELDS = new Set([
  "holdingId",
  "holdingIds",
  "liabilityId",
  "assetId",
]);

/**
 * Id-shaped fields that are declared NOT to name a holding, so the guardian test can
 * tell «classified» from «forgotten». `proposalId` is worthline's own handle for a
 * draft being accumulated into; `memberId` names a person, not a holding.
 */
export const NON_HOLDING_ID_FIELDS = new Set(["proposalId", "memberId"]);

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
  walkDeep(input, (key, value) => {
    if (key === null || !HOLDING_REFERENCE_FIELDS.has(key)) return;
    if (typeof value === "string" && value.trim().length > 0) found.push(value);
  });
  return [...new Set(found)];
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
 * Does this tool answer ASSERT that a holding exists?
 *
 * Only an assertion grounds an id, and three kinds of answer are not assertions:
 *  - an error envelope, because an error may quote back what it was handed —
 *    `explain_figure({figure: "wl_hld_…"})` answers «Unknown figure: wl_hld_…», and a
 *    refusal from this very module used to echo the invented id it refused, which
 *    grounded it for the next turn. That is the invariant laundering itself;
 *  - `suggest_actions`, whose output carries the model's own follow-up prompts back;
 *  - a write, since its input is the thing under suspicion. A prepared proposal is a
 *    server-built object whose id already resolved, but it needs no second grounding:
 *    it is only ever built from an id that was already grounded.
 */
export function assertsHoldingIds(toolName: string, output: unknown): boolean {
  if (requiresGroundedHoldingIds(toolName) || toolName === "suggest_actions")
    return false;
  return !isErrorEnvelope(output);
}

/** Every shape a chat tool refuses with carries `error` — envelope or bare code. */
function isErrorEnvelope(output: unknown): boolean {
  return typeof output === "object" && output !== null && "error" in output;
}

/**
 * The ids the model may legitimately use next turn: those a tool answer ASSERTED in
 * the history it is about to be sent.
 *
 * A proposal's own output is excluded with every other write (see
 * {@link assertsHoldingIds}) and the ordinary «cámbiale el importe» follow-up survives
 * anyway: the read that grounded the proposal in the first place is in the same
 * history, and if the ceiling dropped it (#1260) the model has lost the id too.
 */
export function groundedHoldingIdsInHistory(messages: readonly UIMessage[]): string[] {
  return [
    ...new Set(
      toolOutputsIn(messages).flatMap(({ name, output }) =>
        assertsHoldingIds(name, output) ? publicHoldingIdsIn(output) : [],
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

/**
 * The typed envelope, sibling of the unvalidated-evidence and paywall errors.
 *
 * It deliberately does NOT name the id it refused. An earlier version echoed it, and
 * that echo was a way out of the invariant: the refusal is itself a tool output, so
 * the invented id landed in the history and grounded itself for the next turn. The
 * ids go to the route's log instead, where they are read by a person.
 */
export interface UngroundedHoldingIdError {
  error: "ungrounded_holding_id";
  message: string;
}

export function ungroundedHoldingIdRejected(): UngroundedHoldingIdError {
  return { error: "ungrounded_holding_id", message: UNGROUNDED_HOLDING_ID_MESSAGE };
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
            return ungroundedHoldingIdRejected();
          }
        : async (input, options) => {
            const output = await execute(input, options);
            if (assertsHoldingIds(name, output)) grounded.record(output);
            return output;
          };
      return [name, { ...tool, execute: wrapped }];
    }),
  );
}

type ToolExecute = (input: unknown, options: unknown) => unknown;
