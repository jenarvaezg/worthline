/**
 * The golden set the admission gate runs, in two dimensions.
 *
 * Reading came first (#668). Tool discipline was added in #1265 after a live run
 * scored the pool's model at 88% — on a day it had faked a proposal card in prose
 * and invented a holding id — because nothing in the set asked whether the turn
 * called the tool it claimed to call. The order matters for a practical reason:
 * the write-path questions run last, so a provider that exhausts its free tier
 * mid-run leaves the report incomplete rather than silently unscored on reading.
 */

export type { Check, EvalDimension, GoldenQuestion } from "./golden-question";

import type { GoldenQuestion } from "./golden-question";
import { READING_QUESTIONS } from "./golden-reading";
import { TOOL_DISCIPLINE_QUESTIONS } from "./golden-tool-discipline";

export const GOLDEN_QUESTIONS: GoldenQuestion[] = [
  ...READING_QUESTIONS,
  ...TOOL_DISCIPLINE_QUESTIONS,
];
