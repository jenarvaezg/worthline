/**
 * What a golden question measures.
 *
 * Its own module, with no imports, because two very different places need the
 * word: the question set, and the committed pool marks that `provider-pool.ts`
 * validates at import time (#1265). Declaring it next to the questions would drag
 * personas and graders into production's import graph; re-declaring the union in
 * both would let them disagree.
 *
 * The distinction is the point of #1265: a good `reading` score says nothing about
 * whether a model can be trusted on the path that WRITES — the pool's model scored
 * 88% on a day it faked a proposal card in prose. One blended ratio is how that
 * stayed invisible, so the dimension travels with every question and every verdict
 * is computed per dimension. See ADR 0067.
 */
export type EvalDimension = "reading" | "tool-discipline";
