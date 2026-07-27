/**
 * The golden set the admission gate runs, in three dimensions.
 *
 * Reading came first (#668); tool discipline was added in #1265, attachments in
 * #1254, and why they are scored apart is in ADR 0067. The ORDER here is the only
 * decision this file makes: the questions whose score is least forgiving run last, so
 * a provider that dies mid-run has lost them visibly, per question, never quietly.
 * Attachment questions are last of all because they are the newest and the most
 * expensive to reach — the turn carries a document plus every read behind it.
 */

export type { EvalDimension } from "./dimension";
export type { Check, GoldenAttachment, GoldenQuestion } from "./golden-question";

import { ATTACHMENT_QUESTIONS } from "./golden-attachments";
import type { GoldenQuestion } from "./golden-question";
import { READING_QUESTIONS } from "./golden-reading";
import { TOOL_DISCIPLINE_QUESTIONS } from "./golden-tool-discipline";

export const GOLDEN_QUESTIONS: GoldenQuestion[] = [
  ...READING_QUESTIONS,
  ...TOOL_DISCIPLINE_QUESTIONS,
  ...ATTACHMENT_QUESTIONS,
];
