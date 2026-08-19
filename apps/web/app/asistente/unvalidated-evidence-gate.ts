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
import { STATEMENT_GATE_FORMATS } from "@web/patrimonio/importar-extracto/statement-upload-read";

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
  // A dated lump against ONE debt (#1245): amount, date and mode fit in one line
  // of preview, and the impact next to them is computed by the domain — the human
  // eye validates it exactly as it validates a corrected balance.
  propose_early_repayment: "accepts",
  propose_holding: "accepts",
  propose_property_valuation_anchor: "accepts",
  /**
   * `accepts`, no `rejects` como su hermana (#1423): una enmienda no puede meter
   * NINGUNA fila nueva en el patrimonio —opera sobre los puntos que ya están
   * persistidos, seleccionados por fecha— y lo único que puede aportar de una
   * lectura sin validar es UN importe corregido en un punto, que es exactamente el
   * dato puntual que el ojo humano valida en la tarjeta. Clasificarla `rejects`
   * dejaría al usuario con la propuesta ya en pantalla y sin forma de retocarla,
   * que es el agujero que la issue arregla; el cupo de una por turno sigue puesto.
   */
  propose_reconstruction_amendment: "accepts",
  // Bulk import: the deterministic route owns these, always.
  propose_balance_history_import: "rejects",
  propose_mixed_document_import: "rejects",
  propose_reconcile: "rejects",
  propose_reconstruction: "rejects",
  propose_statement_import: "rejects",
  // Born from a gesture over ids already read, not from a document.
  propose_holding_removal: "neutral",
  propose_holding_restoration: "neutral",
  /**
   * `neutral` because its OWN frontier is strictly stronger than this gate (#1374):
   * the date, the amount, the participaciones and the commission are read off a
   * validated `holding_event`, checked before the store is even opened, so evidence
   * worthline could not validate can never become an operation — there is nothing for
   * the gate to protect. Classifying it `rejects` would also lie: the routing copy
   * offers «un dato puntual sí puedo prepararlo como propuesta», and this IS that
   * single dated fact. And it would block the legitimate turn where an unreadable
   * spreadsheet arrived earlier in the conversation while the confirmation the user is
   * asking about was validated in a previous message.
   */
  propose_operation: "neutral",
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

/**
 * The `rejects` lanes a series the USER TYPED reopens (#1418) — the two that import a
 * dated balance series of a debt, and only those.
 *
 * The escape is not «trust the user's message»: it is that worthline PARSES the
 * message itself ({@link ../typed-balance-series}) and the lane builds from that
 * parse, never from the model's arguments. So it is available exactly where a
 * deterministic parser can read the rows off chat text — a date and a balance.
 *
 * The other three stay closed on purpose. A statement import, a reconcile and a mixed
 * document are positions, movements and segments: nothing here can read those off a
 * message without guessing what each column means, and a guess is the bulk write this
 * whole boundary exists to prevent. Their route remains the deterministic one.
 *
 * These two have a deterministic route as well since #1406 gave the bank's schedule its
 * own reader behind the same door (ADR 0071), and that does not make this escape idle: a
 * person who has just been told their file cannot be read in bulk, and who answers by
 * typing the figures, is on the manual path in the surface they are already standing in.
 * What it does mean is that every refusal here can name the importer as an alternative —
 * and must, which is why the copy below does.
 *
 * Enumerated here, next to the frontier it pierces, so the guardian test can assert
 * that every escape belongs to a lane the frontier actually closes.
 */
export const TYPED_SERIES_REOPENS = {
  propose_balance_history_import: true,
  propose_reconstruction: true,
} as const;

/** Whether a user-typed series can reopen this tool's lane (#1418). */
export function typedSeriesReopens(toolName: string): boolean {
  return Object.hasOwn(TYPED_SERIES_REOPENS, toolName);
}

/**
 * What a debt-series lane may do this turn (#1418).
 *
 * A discriminated union and not rows-plus-a-flag: the rows are ALWAYS all of one
 * provenance, so a `(Model | Typed)[]` beside a boolean would be a type that lies about
 * every element it holds. Here the source and the array cannot disagree.
 */
export type GatedDebtSeries<Model, Typed> =
  /** Build from these rows. `source` says whose figures they are. */
  | { source: "model"; rows: readonly Model[] }
  | { source: "user_typed"; rows: readonly Typed[] }
  /** The gate bites and nothing reopened it. */
  | { source: "closed" }
  /** The user DID write dated figures and worthline could not read them as a series. */
  | { source: "unreadable_series" };

/**
 * Which rows a debt-series lane may build from this turn.
 *
 * The escape is `user_typed`, and the two things it does are equally load-bearing. It
 * ALLOWS the call — otherwise a user who typed the series by hand has no way out but
 * uploading a file, which is the dead end this closes. And it REPLACES the rows: the
 * model has the unvalidated document in its context, so rows it typed could be figures
 * it remembers from the document rather than from the message. They are dropped, never
 * merged — merging would let a single remembered row ride in beside three real ones,
 * which is exactly the write nobody validated.
 *
 * `unreadable_series` exists because `closed` was answering two questions with one word.
 * A person who wrote the series and whose paste we could not parse was getting the copy
 * that asks for the series — the disease #1418 was filed for, one level further in.
 *
 * Generic over both row shapes because the two are not the same: the model may attach
 * a rate to its rows and the parser never invents one. Nothing here reads a field —
 * the decision is about PROVENANCE, and provenance is about where the array came from.
 */
export function gatedDebtSeries<Model, Typed>({
  gated,
  modelRows,
  toolName,
  typedSeries,
}: {
  gated: boolean;
  modelRows: readonly Model[];
  toolName: string;
  typedSeries:
    | { status: "read"; rows: readonly Typed[] }
    | { status: "absent" }
    | { status: "unreadable" };
}): GatedDebtSeries<Model, Typed> {
  if (!gated) return { rows: modelRows, source: "model" };
  if (!typedSeriesReopens(toolName)) return { source: "closed" };
  if (typedSeries.status === "read") {
    return { rows: typedSeries.rows, source: "user_typed" };
  }
  return { source: typedSeries.status === "unreadable" ? "unreadable_series" : "closed" };
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
 *
 * That «rest of the conversation» is no longer a dead end for a debt's balance
 * history (#1418): a series the user TYPES in a turn is parsed by worthline itself and
 * reopens the two lanes of {@link TYPED_SERIES_REOPENS}. It does not go through this
 * predicate — the gate's verdict about the turn is unchanged, and the escape is
 * per-lane and per-turn, granted only where the rows come from the parse instead of
 * from the model's arguments.
 *
 * What #1418 CONSIDERED and did not do, so nobody re-derives it from scratch: making
 * the trace EXPIRE when the document leaves active context. It was rejected on its
 * premise. The unstructured grid is never kept in history at all — it is rendered into
 * one turn's copy and gone (`prepareAttachmentMessagesForModel`), and what survives is
 * the model's own prose about it, which no three-document window bounds. So there is no
 * moment at which «the document left context» is a fact this predicate could read, and
 * expiry would not have helped the conversation that filed the ticket either: it
 * carried exactly one file, so nothing would ever have aged out. The inversion the
 * ticket names — reading a document BETTER closes a door an unreadable one leaves open
 * — therefore still stands for positions, movements and mixed documents. Closing it
 * needs a different lever: those lanes have a deterministic route, and this one did not.
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
 *
 * The last sentence is the door #1418 opened, said HERE because this envelope is what
 * the model reads when the lane refuses: the alternative was a user pasting 360 rows
 * that could not work and nobody telling him. It is conditional («si es el histórico de
 * saldos de una deuda») because that is the only shape a parser can read off chat text
 * — positions and movements still have one honest route, the file.
 */
export const UNVALIDATED_EVIDENCE_MESSAGE =
  "Ese archivo no lo he podido leer como tabla de posiciones o movimientos, así que no " +
  "puedo llevarlo en bloque al patrimonio. En /patrimonio/importar-extracto entran " +
  `${STATEMENT_GATE_FORMATS.join(" o ")}, y nada más; ` +
  "y si tienes el extracto original del banco o del broker, " +
  "ése sí puedo leerlo. Un dato puntual sí puedo prepararlo como propuesta para que lo " +
  "confirmes. Y si lo que quieres cargar es el histórico de saldos de una deuda, " +
  "escríbeme aquí las fechas y los saldos, una línea por fecha: eso sí lo leo de tu " +
  "mensaje.";

/** The per-turn cap: a second proposal out of the same unvalidated document. */
export const UNVALIDATED_EVIDENCE_CAP_MESSAGE =
  "Ya he preparado una propuesta a partir de ese archivo sin validar y solo puedo hacer " +
  "una por mensaje: varios apuntes de golpe son una importación, y ese archivo no lo he " +
  "podido leer como tabla. Para cargarlo entero, en /patrimonio/importar-extracto entran " +
  `${STATEMENT_GATE_FORMATS.join(" o ")}; ` +
  "o pásame el extracto original del banco o del broker.";

/**
 * The user wrote the series and worthline could not read it (#1418).
 *
 * A DIFFERENT message from the one above, and that difference is the point: repeating
 * «escríbeme las fechas y los saldos» at somebody who has just written them is the
 * failure this ticket is named after. So this one says what it tried, what shape works,
 * and the two things that most often break a real paste — a balance that goes up, and
 * two figures for the same date.
 *
 * The file route comes LAST and as an alternative, never as the fix: it exists since
 * #1406 gave the bank's schedule its own reader behind the same door (ADR 0071), so
 * withholding it would be hiding a working path — but leading with it would be answering
 * «I could not read what you wrote» with «upload a file instead», which is the shrug the
 * whole ticket is about.
 */
export const UNREADABLE_TYPED_SERIES_MESSAGE =
  "He intentado leer la serie de saldos que me has escrito y no he podido, así que no " +
  "he preparado nada — el trabajo no se ha perdido, solo necesito el formato. Escríbeme " +
  "una línea por fecha, con la fecha y el saldo pendiente y nada más (por ejemplo " +
  "«01/10/2025 198.456,78»). Ojo a dos cosas que me lo impiden: que el saldo suba de " +
  "una fecha a la siguiente, y que haya dos cifras distintas para la misma fecha. Si " +
  "prefieres no reescribirlo, el cuadro del banco entero se carga en " +
  "/patrimonio/importar-extracto, pestaña «Cuadro de amortización».";

/**
 * The typed envelope the model relays. Sibling of the paywall's
 * `premiumRequired` and deliberately NOT the same: the reason is different and
 * the way out is the deterministic route, never paying.
 */
export interface UnvalidatedEvidenceError {
  error:
    | "unvalidated_evidence"
    | "unvalidated_evidence_limit"
    | "unreadable_typed_series";
  message: string;
}

export function unvalidatedEvidenceRejected(): UnvalidatedEvidenceError {
  return { error: "unvalidated_evidence", message: UNVALIDATED_EVIDENCE_MESSAGE };
}

/** The refusal for a series that was written and could not be read (#1418). */
export function unreadableTypedSeriesRejected(): UnvalidatedEvidenceError {
  return {
    error: "unreadable_typed_series",
    message: UNREADABLE_TYPED_SERIES_MESSAGE,
  };
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
