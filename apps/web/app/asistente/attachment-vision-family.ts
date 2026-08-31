import type { Output } from "ai";

import type { AttachmentExtractionResult } from "./attachment-extraction-contract";
import type {
  VisionFamilyDocumentType,
  VisionIdentification,
} from "./attachment-vision-identification";

/**
 * What ONE document family owes the vision seam (#1699).
 *
 * The seam asks the identification call what the document is and then hands the answer
 * to the family that claims it. A family therefore has to say two things at most: what
 * to make of the cheap reading, and — when its rows are too fat a branch to ask for in
 * the same schema as everybody else's (#1345, #1487) — the second question it wants
 * asked, the prompt for it, and how to assemble what comes back.
 *
 * Nothing here is generic infrastructure and nothing here knows a sibling family: a new
 * document family is a new module implementing this interface plus its line in the
 * registry, and no existing family file is opened.
 */
export interface VisionDocumentFamily {
  /** The `documentType` this family answers for, as the identification call names it. */
  documentType: VisionFamilyDocumentType;
  /**
   * The verdict when the reading STOPS at the identification — either because this
   * family asks no second question, or because the detail call was skipped or never
   * earned. It always returns something the turn can use, never a hard failure.
   */
  fromIdentification(identification: VisionIdentification): AttachmentExtractionResult;
  /** The second, narrower question this family pays for, when it has one. */
  detail?: VisionDetailCall;
}

/** The SECOND vision call of a family: asked only of a document already typed as its. */
export interface VisionDetailCall {
  /**
   * Does THIS identification earn the call? Asked only after `documentType` matched, so
   * a family with no further condition answers `true`.
   */
  earnedBy(identification: VisionIdentification): boolean;
  /** The prompt, self-contained: a prompt is not inherited between calls. */
  instructions: string;
  /**
   * The provider-facing output spec — the shape ASKED for and the tolerant one ACCEPTED
   * back. A function so it is built per request, as it always was.
   */
  output(): Output.Output;
  /**
   * Assemble the provider's answer into the common envelope. Output this seam cannot
   * read DECLINES (the descriptive lane) rather than failing, which is why parsing
   * belongs to the family and not to the orchestrator.
   */
  read(output: unknown, identification: VisionIdentification): AttachmentExtractionResult;
}
