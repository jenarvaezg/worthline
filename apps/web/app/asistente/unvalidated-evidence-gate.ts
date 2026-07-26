/**
 * The unvalidated-evidence boundary (#1248, PRD #1241): what worthline has NOT
 * validated cannot become a bulk write. Until this module existed the rule lived
 * only in the system prompt — one paragraph competing with fourteen other rules
 * — which is a hope, not a guarantee, once money passes through that door.
 *
 * The frontier, decided in the PRD's grilling:
 *  - A single fact verifiable at a glance (a corrected balance, an appraisal
 *    figure, one holding's current value) MAY feed a proposal: the user reads the
 *    preview and confirms it, so the human eye is the validator.
 *  - A BULK IMPORT never may. Its place is the deterministic route — upload the
 *    file so the typed extractor reads it, or `/patrimonio/importar-extracto`.
 *    The error therefore ROUTES; it does not just block.
 *
 * Everything here is pure and enumerable, so the invariant is testable in CI
 * without API keys — unlike the prompt sentence it replaces.
 */

/** How a chat tool relates to evidence worthline has not validated. */
export type UnvalidatedEvidenceClass = "accepts" | "rejects" | "neutral";

/**
 * Every proposal tool's side of the frontier, declared explicitly. `neutral`
 * means the tool is born from a user gesture over ids already read, never from a
 * document — so unvalidated evidence is irrelevant to it. The guardian test
 * enumerates `createChatTools` and fails when a new `propose_*` tool is missing
 * here, which is what keeps the boundary from being forgotten in a later slice.
 */
export const UNVALIDATED_EVIDENCE_CLASSES = {
  // Single fact, verifiable at a glance, confirmed in a preview.
  propose_correction: "accepts",
  propose_holding: "accepts",
  propose_property_valuation_anchor: "accepts",
  // Bulk import: the deterministic route owns these, always.
  propose_balance_history_import: "rejects",
  propose_mixed_document_import: "rejects",
  propose_reconcile: "rejects",
  propose_reconstruction: "rejects",
  propose_statement_import: "rejects",
  // Born from a gesture over ids already read, not from a document.
  propose_holding_removal: "neutral",
  propose_holding_restoration: "neutral",
} as const satisfies Record<string, UnvalidatedEvidenceClass>;

/**
 * The class of a tool. Anything unclassified is `neutral`: reads and
 * `suggest_actions`/`raise_maintainer_alert` never turn a document into a write,
 * so they must keep working untouched while an unvalidated sheet is on the table.
 */
export function unvalidatedEvidenceClassFor(toolName: string): UnvalidatedEvidenceClass {
  return (
    (UNVALIDATED_EVIDENCE_CLASSES as Record<string, UnvalidatedEvidenceClass>)[
      toolName
    ] ?? "neutral"
  );
}

export interface UnvalidatedEvidenceFacts {
  /**
   * Evidence worthline could not validate is in play — today a readable
   * spreadsheet handed to the model as a raw grid (#865), either attached in this
   * turn or left as a trace by an earlier one. The trace matters because the grid
   * is stripped from history while the model's reading of it survives in its own
   * answers: without it, a second turn with no attachment reopens the door.
   *
   * An attachment that could NOT be read does not count: the model then holds no
   * document at all, so the source is the user's own text and that is the
   * ordinary manual path.
   */
  hasUnvalidatedEvidence: boolean;
  /**
   * THIS turn brought a worthline-validated document. Only this turn — a
   * validated preview kept in history arrives from the client and is checked for
   * shape, not authenticity, so trusting it would let a forged `valid` envelope
   * disable the boundary. Narrowing the exemption to the extraction this route
   * just produced removes that surface, and costs nothing real: a turn that
   * brings no unvalidated evidence at all is never gated to begin with.
   */
  hasValidatedDocumentInThisTurn: boolean;
}

/**
 * The gate bites on unvalidated evidence unless this very turn brought a
 * validated document to lean on.
 *
 * Accepted cost, decided with the frontier: one unreadable sheet leaves the five
 * bulk-import tools closed for the rest of the conversation, and the way out is
 * the deterministic route — which is where a bulk import belongs anyway. The
 * whitelisted single-fact tools stay open throughout, capped at one per turn, and
 * uploading a document worthline CAN read reopens everything in that same turn.
 */
export function unvalidatedEvidenceGateApplies({
  hasUnvalidatedEvidence,
  hasValidatedDocumentInThisTurn,
}: UnvalidatedEvidenceFacts): boolean {
  return hasUnvalidatedEvidence && !hasValidatedDocumentInThisTurn;
}

/** One proposal per turn out of unvalidated evidence — twelve of them are an import. */
export const MAX_UNVALIDATED_PROPOSALS_PER_TURN = 1;

/**
 * A bulk-import tool was called with only unvalidated evidence to stand on. The
 * copy never tells the user to upload the file again: the gate is open PRECISELY
 * because a file was already uploaded and could not be read as a table. It
 * names why, shows where the expected format lives, and offers the one document
 * that would work — the original statement from the bank or broker.
 *
 * The noun is «ese archivo», deliberately NEUTRAL. Until #1246 only a spreadsheet
 * could open this gate, so «esa hoja» was true by construction; the descriptive
 * reading of a capture opens it too, and telling someone who uploaded a screenshot
 * «esa hoja no la he podido leer» names a document that never existed. The
 * boundary's own tests assert the wording now, so the next lane cannot make it
 * lie again in silence.
 */
export const UNVALIDATED_EVIDENCE_MESSAGE =
  "Ese archivo no lo he podido leer como tabla de posiciones o movimientos, así que no " +
  "puedo llevarlo en bloque al patrimonio. En /patrimonio/importar-extracto tienes el " +
  "formato que sí reconozco; y si tienes el extracto original del banco o del broker, " +
  "ése sí puedo leerlo. Un dato puntual sí puedo prepararlo como propuesta para que lo " +
  "confirmes.";

/** The per-turn cap: a second proposal out of the same unvalidated document. */
export const UNVALIDATED_EVIDENCE_CAP_MESSAGE =
  "Ya he preparado una propuesta a partir de ese archivo sin validar y solo puedo hacer " +
  "una por mensaje: varios apuntes de golpe son una importación, y ese archivo no lo he " +
  "podido leer como tabla. Para cargarlo entero mira el formato de " +
  "/patrimonio/importar-extracto, o pásame el extracto original del banco o del broker.";

/**
 * The typed envelope the model relays. Sibling of the paywall's
 * `premiumRequired` and deliberately NOT the same: the reason is different and
 * the way out is the deterministic route, never paying.
 */
export interface UnvalidatedEvidenceError {
  error: "unvalidated_evidence" | "unvalidated_evidence_limit";
  message: string;
}

export function unvalidatedEvidenceRejected(): UnvalidatedEvidenceError {
  return { error: "unvalidated_evidence", message: UNVALIDATED_EVIDENCE_MESSAGE };
}

export function unvalidatedEvidenceCapReached(): UnvalidatedEvidenceError {
  return {
    error: "unvalidated_evidence_limit",
    message: UNVALIDATED_EVIDENCE_CAP_MESSAGE,
  };
}

/**
 * Whether a tool result is a prepared proposal — the only outcome that spends
 * the per-turn cap. Deliberately a POSITIVE contract: every proposal shape
 * carries `proposalType` (it is what the client parses to render the preview), so
 * a future builder reporting failure some other way than an `error` envelope can
 * never burn the user's single slot.
 */
export function consumesUnvalidatedEvidenceBudget(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "proposalType" in (result as Record<string, unknown>)
  );
}

export interface UnvalidatedProposalBudget {
  /** Takes a slot SYNCHRONOUSLY, reporting whether there was one to take. */
  reserve: () => boolean;
  /** Gives a reserved slot back when no proposal came out of it. */
  release: () => void;
}

/**
 * The turn's proposal budget. This is the ONE piece of mutable state the
 * boundary needs: `createChatTools` runs once per turn, so the counter lives in
 * that closure and spans the several tool rounds `streamText` may take — a cap
 * per turn, never per conversation.
 *
 * `reserve` is synchronous and reserve-then-release rather than
 * check-then-consume on purpose: the AI SDK runs every tool-call of one step
 * concurrently (`Promise.all`), so a check with an `await` before the increment
 * would let N simultaneous calls all see `used = 0` and all pass — the bulk
 * import walking in through the very door this boundary closes.
 */
export function createUnvalidatedProposalBudget(
  limit: number = MAX_UNVALIDATED_PROPOSALS_PER_TURN,
): UnvalidatedProposalBudget {
  let used = 0;
  return {
    reserve: () => {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
    release: () => {
      used -= 1;
    },
  };
}
