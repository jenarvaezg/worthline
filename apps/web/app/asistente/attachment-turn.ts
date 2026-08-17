import { markProjectedBalances } from "@web/asistente/attachment-balance-projection";
import type {
  AttachmentPreviewData,
  UnstructuredAttachment,
  UnstructuredSource,
} from "@web/asistente/attachment-chat";
import type { UnrecognizedReason } from "@web/asistente/attachment-extraction-contract";
import { readSpreadsheetContext } from "@web/asistente/attachment-spreadsheet-context";
import { extractSpreadsheetDocument } from "@web/asistente/attachment-spreadsheet-dispatch";
import {
  UNSTRUCTURED_EMPTY_READING_MESSAGE,
  UNSTRUCTURED_SPREADSHEET_MESSAGE,
  UNSTRUCTURED_VISION_MESSAGE,
} from "@web/asistente/attachment-types";
import { describeVisionAttachment } from "@web/asistente/attachment-vision-description";
import { extractDocumentFromVisionAttachment } from "@web/asistente/attachment-vision-extractor";

/**
 * What ONE attachment becomes when it arrives in a turn (PRD #1241) — the card the
 * user reads, and the lane through which the document (or only its verdict) reaches
 * the model.
 *
 * It lived inside `api/chat/route.ts` until #1254, which is where it stopped being
 * enough: the assistant eval could not attach a file, so no behaviour of this seam
 * entered the comparison between models — «does it ask when the holding is ambiguous?
 * does it respect the unvalidated-evidence frontier?» were ungradeable questions. The
 * harness now runs THIS module rather than a copy of it, for the same reason the eval
 * wires the route's own tool slice instead of a subset (#1265): a second copy measures
 * the copy. Everything policy-shaped — quotas, the paywall, rate limits, cooldowns —
 * stays in the route, because it is about the caller, not about the document.
 */
export interface AttachmentTurnInput {
  bytes: Uint8Array;
  /** As the user's file arrives; trimmed here, at the one place that reads it. */
  fileName: string;
  mimeType: string;
  /**
   * The turn's own valuation date, `YYYY-MM-DD` (#1424) — passed in and never read
   * off the wall clock, because a demo target runs on a pinned one (`chatAsOf`).
   *
   * It is the fact no document carries: an amortization schedule is half history and
   * half forecast, and only today's date says where the line falls. See
   * {@link markProjectedBalances}.
   */
  today: string;
}

/**
 * A reading worthline could not validate, not yet fitted to any model (#1419).
 *
 * The reading happens ONCE per turn; the prompt is built once per PROVIDER, and their
 * budgets differ by an order of magnitude (`turn-prompt-budget.ts`). So the seam hands
 * back something renderable rather than rendered text, and {@link fitTo} is called with
 * the budget of the model that is about to read it. Rendering here instead would either
 * hand the narrow fallback a book it must reject, or ration the primary to the
 * fallback's size — the mistake #1408 removed from the prose lane.
 */
export interface UnstructuredReading {
  fileName: string;
  source: UnstructuredSource;
  /** The block this model gets, sampled only as far as its budget forces. */
  fitTo: (budgetChars: number) => UnstructuredAttachment;
}

function unstructuredReading(
  fileName: string,
  source: UnstructuredSource,
  render: (budgetChars: number) => string,
): UnstructuredReading {
  return {
    fileName,
    fitTo: (budgetChars) => ({ fileName, source, text: render(budgetChars) }),
    source,
  };
}

export interface AttachmentTurnReading {
  /** The extraction verdict, always shown to the user (#1242). */
  preview: AttachmentPreviewData;
  /**
   * Evidence worthline could NOT validate, handed to the model to discuss (#865,
   * #1246). Non-null is exactly what opens the unvalidated-evidence gate (#1248),
   * so the caller derives that flag from this field rather than guessing from MIME.
   */
  unstructured: UnstructuredReading | null;
  /**
   * How many vision model calls this reading paid for (#1258) — the number the
   * caller's fuse counts. Zero for the deterministic spreadsheet route, one for a
   * document the seam identified in a single call, two when either cascade ran (the
   * detail read of a dated fact, #1345, or the descriptive drain, #1246) and three in
   * the one case that runs both: a dated fact identified, read in detail, and then
   * declined — the detail is what the descriptive lane exists to rescue.
   *
   * The seam reports it because only the seam knows: the extractors hand back a
   * validated verdict and never provider usage, and a policy layer reading MIME
   * types would be guessing at the branch that was actually taken.
   */
  visionCalls: number;
}

/**
 * The card a DESCRIBED capture gets, per verdict that sent it down the lane (#1246).
 *
 * A `Record` over the closed reason set, so a third `unrecognized` fact cannot be added
 * without deciding what its card says. Both entries are markers the unvalidated-evidence
 * boundary reads back out of history (#1248) and both are registered there — the card is
 * what tells a later turn that this conversation already has unvalidated evidence on the
 * table, so a message missing from that list is a gate that quietly stops biting.
 */
const DESCRIBED_CARD_MESSAGE: Record<UnrecognizedReason, string> = {
  empty_reading: UNSTRUCTURED_EMPTY_READING_MESSAGE,
  unidentified_document: UNSTRUCTURED_VISION_MESSAGE,
};

/** Which transport a file travels in — the MIME type picks it, and only it (#1243). */
function visionTransport(input: {
  fileName: string;
  mimeType: string;
}): "image" | "pdf" | null {
  const mimeType = input.mimeType.toLowerCase();
  if (mimeType === "application/pdf" || input.fileName.toLowerCase().endsWith(".pdf")) {
    return "pdf";
  }
  return mimeType.startsWith("image/") ? "image" : null;
}

/**
 * Will this file reach a vision model at all? Exported for the caller's money fuse
 * (#1258), which must not brake an upload that costs nothing: a spreadsheet takes
 * the deterministic, model-free route, so refusing one on a spent allowance would
 * be both a lie and a needless dead end. The transport decision lives HERE, in the
 * seam that acts on it, so the gate and the reading can never disagree about which
 * lane a file is in.
 */
export function isVisionAttachment(input: {
  fileName: string;
  mimeType: string;
}): boolean {
  return (
    visionTransport({ fileName: input.fileName.trim(), mimeType: input.mimeType }) !==
    null
  );
}

/**
 * Read one attachment: identify the document, and choose the lane it travels in.
 *
 * The MIME type picks the *transport* only (#1243): one vision seam identifies the
 * document behind an image or a PDF by its content, while a spreadsheet keeps its
 * stronger, deterministic, model-free route.
 */
export async function readAttachmentTurn(
  input: AttachmentTurnInput,
): Promise<AttachmentTurnReading> {
  const fileName = input.fileName.trim();
  const extractionInput = { bytes: input.bytes, fileName, mimeType: input.mimeType };
  const visionKind = visionTransport({ fileName, mimeType: input.mimeType });
  const isSpreadsheet = visionKind === null;

  // What this reading owes the money fuse (#1258) comes from the seam that did the
  // asking, because only it knows which branch was taken: zero for the deterministic
  // sheet route and for a file refused over bytes already in memory, one for an
  // identified document, and TWO when an identified dated fact also paid for its
  // detail call (#1345). Deriving it here from the verdict instead would be guessing
  // — a `holding_event` card looks the same whether it cost one call or two.
  const extraction = isSpreadsheet
    ? { result: extractSpreadsheetDocument(extractionInput), visionCalls: 0 }
    : await extractDocumentFromVisionAttachment({ ...extractionInput, kind: visionKind });
  // The one thing neither extractor can know (#1424): which of a schedule's dated
  // balances already happened. Stamped over the validated verdict of BOTH lanes, so
  // there is one answer for a cuadro de amortización whether it arrived as a PDF or
  // as an .xlsx — the asymmetry #1417 already had to remove once.
  const result = markProjectedBalances(extraction.result, input.today);
  const extractionCalls = extraction.visionCalls;

  // A readable spreadsheet that is not a positions table becomes conversational
  // material instead of a dead-end (#865): the WHOLE book goes to the model — every
  // sheet, every row, every column (#1419) — for it to describe, never as validated
  // figures. What it does not carry is a count-shaped cut but the reading model's own
  // budget, which is why it is read here and rendered later.
  if (result.status === "unrecognized" && isSpreadsheet) {
    const context = readSpreadsheetContext(extractionInput);
    if (context) {
      return {
        preview: {
          fileName,
          result: { message: UNSTRUCTURED_SPREADSHEET_MESSAGE, status: "unrecognized" },
        },
        unstructured: unstructuredReading(fileName, "spreadsheet_grid", (budgetChars) =>
          context.render(budgetChars),
        ),
        visionCalls: 0,
      };
    }
  }

  // Parity for pixels (#1246): a capture the seam extracted nothing from had no drain at
  // all, so it died on the card. A SECOND call to the same fixed model outside the pool
  // says what is on screen, and it enters the turn through the very same unstructured
  // lane, with the same defenses.
  //
  // BOTH shapes of `unrecognized` take that drain. Only `unidentified_document` used to,
  // on the argument that describing a document we HAD identified would merely paraphrase
  // what could not be read — and a real capture disproved it. MyInvestor's «Composición»
  // tab came back `empty_reading` (the positions contract had no shape for a row without
  // units, widened in the same pass) and the turn reached the model with NOTHING: not the
  // total printed at the top of the screen, not the name of a single fund. What the
  // description would have carried is precisely the content the rows could not, so the
  // paraphrase argument was backwards: a reading that failed leaves the MOST to describe,
  // not the least.
  //
  // The transport check is not redundant with the reason: the deterministic sheet route
  // never stamps this discriminant today, and this keeps a future one that did from
  // sending a workbook to a vision model and clobbering its own rendered grid. A verdict
  // with NO reason is still not described — only the vision seam stamps one, and a route
  // that cannot say which of the two facts held cannot say a description would help.
  const describedReason =
    visionKind !== null && result.status === "unrecognized" && result.reason !== undefined
      ? result.reason
      : null;
  const description =
    describedReason !== null && visionKind !== null
      ? await describeVisionAttachment({ ...extractionInput, kind: visionKind })
      : null;
  // Charged on the ASK, not on the answer (#1258): a description the provider failed
  // to give back still cost a request, and it is the branch above — not the outcome —
  // that the abuse the fuse guards against reaches for. Two calls now cover one verdict
  // more than they did, which is what the content above costs.
  //
  // This is also where the worst case became three (#1345): a screen typed as a dated
  // fact whose detail read is then declined pays for identification, detail and
  // description. It is the least common branch of the least common document, and the
  // alternative — no description — is the dead end PRD #1241 opened against.
  const visionCalls = extractionCalls + (describedReason ? 1 : 0);

  if (description && describedReason) {
    return {
      preview: {
        fileName,
        result: {
          message: DESCRIBED_CARD_MESSAGE[describedReason],
          reason: describedReason,
          status: "unrecognized",
        },
      },
      // A model's own description of a capture is already short, and nothing about it
      // is a series to sample — so it ignores the budget and travels whole.
      unstructured: unstructuredReading(
        fileName,
        "vision_description",
        () => description,
      ),
      visionCalls,
    };
  }

  // Any other non-valid verdict (unreadable, unrecognized, out of limits) does NOT end
  // the turn (#1242): the preview card carries the message and the conversational model
  // gets the verdict alone — never content it never read — so it can say what happened,
  // ask what the document is and offer the manual route instead of a canned line.
  return { preview: { fileName, result }, unstructured: null, visionCalls };
}
