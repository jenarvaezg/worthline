import type { ValidatedAttachment } from "@web/asistente/attachment-chat";
import type { ExtractedDocument } from "@web/asistente/attachment-extraction-contract";
import type { MaintainerAlertRefusal } from "@web/asistente/maintainer-alert-evidence";
import type { TypedBalanceSeriesReading } from "@web/asistente/typed-balance-series";
import type { TypedTransferReading } from "@web/asistente/typed-transfer";
import type { MaintainerAlertCategory, RaisedMaintainerAlert } from "@worthline/db";
import type { ChatReadStore } from "./stores";

/**
 * Everything ONE chat turn hands the tools (#629/#630, ADR 0047). The chat route
 * is what knows what the turn carries — which documents worthline validated, what
 * the user typed, which ids earlier answers already surfaced — so every gate below
 * is an input and never something a tool sniffs out for itself.
 *
 * Every field but `runWithStore` and `asOf` has a default that preserves the
 * read-only behaviour of a fixture or an eval exactly.
 */
export interface ChatToolsInput {
  /** Runs one scoped tool operation against the caller's resolved workspace. */
  runWithStore: <T>(run: (store: ChatReadStore) => Promise<T>) => Promise<T>;
  /** YYYY-MM-DD valuation date — the demo clock for demo targets. */
  asOf: string;
  /**
   * Whether premium document ingestion is allowed for the caller (PRD #1160 S2,
   * #1162) — false only for an authenticated `free` workspace. When false, the
   * document-ingestion tools (statement import, portfolio/document reconcile,
   * mixed-document import, reconstruction) short-circuit with an honest
   * `premium_required` envelope the model relays; manual tracking tools
   * (holding create/correct/remove/restore) and every read stay available. The
   * route also gates attachment upload itself, so this is defense-in-depth for a
   * text-only ingestion attempt. Defaults to allowed for read-only fixtures.
   */
  ingestionAllowed?: boolean;
  /**
   * Whether this turn's only document is evidence worthline did NOT validate
   * (#1248, PRD #1241) — computed by the chat route, which is what knows what the
   * turn carries. When true, the bulk-import tools short-circuit with a typed
   * envelope that routes to the deterministic path, the single-fact proposal
   * tools stay open but capped at one per turn, and every read is untouched.
   * Orthogonal to {@link ingestionAllowed}: the two gates ACCUMULATE, they never
   * substitute one another. Defaults to «no unvalidated evidence», so read-only
   * fixtures and the evals keep their exact behaviour.
   */
  unvalidatedEvidence?: boolean;
  /**
   * Whether the turn CARRIES evidence worthline could not validate — the premise
   * {@link unvalidatedEvidence} is the verdict of (#1248). Separate because the
   * provenance mark of #1257 asks the first question and the gate asks the second:
   * a turn that also brought a validated document lifts the gate while the
   * unreadable file stays in the model's context, and that proposal must still say
   * where it comes from. Defaults to the verdict when the caller does not know.
   */
  hasUnvalidatedEvidence?: boolean;
  /**
   * The documents worthline itself extracted and validated for the turn's context —
   * exactly the ones handed to the model in the DATOS ESTRUCTURADOS block. The
   * reconcile lane reads its rows FROM here instead of from the model's arguments
   * (#1373): its contract always said the rows came from an extraction, and until
   * this input existed nothing could check it, so a mistyped holding name became a
   * write against the wrong plan de pensiones. Empty by default, which closes the
   * lane — a fixture or an eval that wants a reconcile must bring the document.
   */
  validatedDocuments?: readonly ExtractedDocument[];
  /**
   * The same documents, with the file names the DATOS ESTRUCTURADOS block uses
   * (#1492). `get_extracted_document` looks up by `fileName` here; a name that is
   * not in this list is refused, never invented. Write tools keep reading rows
   * off {@link validatedDocuments}.
   */
  validatedAttachments?: readonly ValidatedAttachment[];
  /**
   * What this turn's own message turned out to hold, read by worthline itself (#1418).
   * A `read` series is what reopens the two debt-series lanes of
   * {@link TYPED_SERIES_REOPENS} while the evidence gate bites — and the rows those
   * lanes then build from, so a model holding an unreadable grid cannot pass its own
   * remembered figures off as something the user wrote. `unreadable` is what lets a
   * refusal say «I could not read what you wrote» instead of asking for it again.
   * `absent` by default: a caller that does not read the message keeps the gate's old
   * behaviour exactly.
   */
  typedBalanceSeries?: TypedBalanceSeriesReading;
  /**
   * The traspaso this turn's own message states, read by worthline itself (#1482).
   *
   * The whole `propose_transfer` lane builds from THIS and never from the model's
   * arguments: a traspaso writes two rows plus an inherited cost, so an importe the
   * model «remembered» from a portfolio read would move real capital between two real
   * holdings. Absent by default — the lane then refuses and says what it is missing,
   * which is the honest behaviour for a caller that does not read the message.
   */
  typedTransfer?: TypedTransferReading;
  /**
   * Raise a maintainer alert to the control plane (#1050, ADR 0064). Bound by
   * the route to the caller's resolved workspace id, so the tool never needs to
   * know it. Absent in read-only contexts (evals, unit fixtures): the tool then
   * reports the alert as unavailable and the repair path is unaffected.
   */
  raiseMaintainerAlert?: (input: {
    holdingId: string;
    category: MaintainerAlertCategory;
    payload: unknown;
  }) => Promise<RaisedMaintainerAlert | null>;
  /**
   * Public holding ids worthline already surfaced EARLIER in this conversation
   * (#1263) — the route reads them off the tool outputs in the history it is about
   * to send. Together with this turn's own reads they are what grounds a write:
   * anything else in an id field is something the model made up. Empty by default,
   * so a fixture with no history grounds ids only through its reads.
   */
  groundedHoldingIds?: readonly string[];
  /**
   * A write was refused because it pointed at an id no read ever surfaced. The
   * route logs it: the frequency of the invention is the signal for whether the
   * pool's model is fit for the write path (ADR 0067), and it is invisible
   * otherwise — the turn simply carries on without the proposal.
   */
  onUngroundedHoldingId?: (rejection: {
    tool: string;
    ungroundedHoldingIds: string[];
  }) => void;
  /**
   * A maintainer alert was refused for carrying no discrepancy (#1347). Same
   * reason as the callback above, and sharper: this gate can DROP the maintainer's
   * only forensic channel, so if it ever over-blocks the failure mode is silence
   * in the very channel whose job is to break silence.
   */
  onMaintainerAlertRefused?: (rejection: {
    category: string;
    refusal: MaintainerAlertRefusal;
  }) => void;
}
