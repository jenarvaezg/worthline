/**
 * The golden set the admission gate runs, in two dimensions.
 *
 * Reading came first (#668); tool discipline was added in #1265, and why the two
 * are scored apart is in ADR 0067. The ORDER here is the only decision this file
 * makes: the write-path questions run last, so a provider that dies mid-run has
 * lost the dimension whose score is least forgiving — visible per question, never
 * quietly absent.
 */

export type { EvalDimension } from "./dimension";
export type { Check, GoldenQuestion } from "./golden-question";

import type { GoldenQuestion } from "./golden-question";
import { READING_QUESTIONS } from "./golden-reading";
import { TOOL_DISCIPLINE_QUESTIONS } from "./golden-tool-discipline";

export const GOLDEN_QUESTIONS: GoldenQuestion[] = [
  ...READING_QUESTIONS,
  ...TOOL_DISCIPLINE_QUESTIONS,
];
