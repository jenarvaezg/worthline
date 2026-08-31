/**
 * The mechanics both fabricated-ceremony guards share (#1697).
 *
 * There are two of them — the faked proposal (#1262, widened in #1468) and the faked
 * maintainer alert (#1525) — and they were written field for field alike: the same
 * assistant-only door, the same «did the lane deliver» exemption, the same three
 * origins, and a streaming-exemption loop that was character-for-character identical.
 * Only two things really differ between them: their regexes and their two notes of
 * copy. Everything else lives here.
 *
 * WHY the duplication had to go, in the words the corner keeps repeating (#1254): two
 * copies of one rule drift apart in silence the first time either is widened, and both
 * failure modes here only surface in a real conversation — nobody would see the drift.
 *
 * WHAT THE SHAPE OF THIS MODULE IS FOR, and it is the whole point:
 *
 *   **A guard that switches off because a call was MADE switches off precisely when the
 *   call fails.**
 *
 * That is the hole #1468 closed: `isProposalToolPart` only read the tool's NAME, so a
 * `{ error: … }` counted as a proposal and the warning vanished in the worst case — the
 * model tried, worthline refused, and it narrated success anyway. So the spec below
 * splits the two questions that used to be one. {@link FabricatedCeremonySpec.lanes}
 * says which parts are ABOUT the ceremony, by name, and it can only ever choose WHICH
 * verdict the turn gets. The single off switch is
 * {@link FabricatedCeremonySpec.delivers}, and it reads an ANSWER. There is no field a
 * ceremony could fill in to be exempted by the mere presence of a call.
 */

import { isToolUIPart, type UIMessage } from "ai";

import { assistantProse } from "./claim-sentences";
import { toolCallAnswered } from "./tool-parts";

type Part = UIMessage["parts"][number];

/**
 * What a ceremony declares instead of a verdict for a lane whose answer never arrived.
 *
 * The maintainer alert needs it: `raise_maintainer_alert` writes through the control
 * plane BEFORE it returns, so a stream that died after the write leaves an alert that
 * really exists, and accusing there would make the app the liar. The proposal guard
 * does have something true to say about that turn instead (`interrupted`), so it names
 * a verdict.
 */
export const LEAVE_IN_FLIGHT_ALONE = Symbol("leave-in-flight-alone");

/** Everything that differs between one faked ceremony and the other. */
export interface FabricatedCeremonySpec<TVerdict> {
  /**
   * Does the turn's prose assert the ceremony happened?
   *
   * The ceremony's own vocabulary, read sentence by sentence — see `claim-sentences.ts`
   * for the splitting and the negation rule both guards share. Widened only with
   * MEASURED cases, never by guessing at synonyms: the cost of guessing is notes on
   * honest turns, and those are what teach a user to ignore notes.
   */
  claims(prose: string): boolean;
  /**
   * Off a lane's ANSWER: did it come back carrying the real thing?
   *
   * THE off switch, and deliberately the only one (#1468). For the proposal that is
   * «a card was painted», read off the same name→parser table the render uses; for the
   * alert it is `status: "raised"`, the one branch that ran a control-plane write.
   */
  delivers(part: Part): boolean;
  /** The verdict for a lane that was asked and never answered. */
  interrupted: TVerdict | typeof LEAVE_IN_FLIGHT_ALONE;
  /**
   * Which tool parts are about this ceremony at all, by name.
   *
   * Presence alone never exempts a turn — it only chooses between
   * {@link never}, {@link rejected} and {@link interrupted}.
   */
  lanes(part: Part): boolean;
  /** The verdict when no lane was asked at all: the ceremony was invented outright. */
  never: TVerdict;
  /** The verdict when a lane answered and its answer delivered nothing. */
  rejected: TVerdict;
}

/**
 * THE decision for one ceremony, in one place: an assistant turn that claims the
 * ceremony happened while no lane of it delivered anything.
 *
 * Returns the verdict, or `null` when there is nothing to say — which is also what
 * every caller reads as «this turn is fine».
 */
export function fabricatedCeremonyGuard<TVerdict>(
  spec: FabricatedCeremonySpec<TVerdict>,
): (message: UIMessage) => TVerdict | null {
  return (message: UIMessage): TVerdict | null => {
    // Only the assistant can fake the app's own ceremony; the user may well type the
    // same sentence.
    if (message.role !== "assistant") return null;
    const lanes = message.parts.filter((part) => isToolUIPart(part) && spec.lanes(part));
    if (lanes.some(spec.delivers)) return null;
    const answered = lanes.some(toolCallAnswered);
    // ANY unanswered lane exempts, not just an all-unanswered turn: what the exemption
    // protects against is a write that already happened behind a stream that died, and
    // one such lane is enough for that to be possible.
    if (
      spec.interrupted === LEAVE_IN_FLIGHT_ALONE &&
      lanes.some((part) => !toolCallAnswered(part))
    ) {
      return null;
    }
    if (!spec.claims(assistantProse(message))) return null;
    if (lanes.length === 0) return spec.never;
    // A rejected lane outranks an interrupted one in the same turn: both painted
    // nothing, and the answered refusal is the fact worth telling the model.
    return answered ? spec.rejected : (spec.interrupted as TVerdict);
  };
}

/**
 * The assistant turns that faked a ceremony, by id, each with its verdict.
 *
 * The in-flight message is left alone while the turn streams: prose can land before the
 * tool call within one turn, so judging it early would flash an accusation and then
 * withdraw it — worse than being one moment late. That rule belongs to the SCREEN only;
 * the history the model gets back is never in flight, and its callers pass
 * `streaming: false`.
 */
export function messagesWithFabricatedCeremony<TVerdict>(
  messages: readonly UIMessage[],
  streaming: boolean,
  verdictFor: (message: UIMessage) => TVerdict | null,
): ReadonlyMap<string, TVerdict> {
  const fabricated = new Map<string, TVerdict>();
  messages.forEach((message, index) => {
    if (streaming && index === messages.length - 1) return;
    const verdict = verdictFor(message);
    if (verdict !== null) fabricated.set(message.id, verdict);
  });
  return fabricated;
}
