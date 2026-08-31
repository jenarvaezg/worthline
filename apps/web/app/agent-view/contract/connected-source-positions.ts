import type { AgentViewSourceFreshnessSummary } from "./holdings";
import type {
  AgentViewLiquidityTier,
  AgentViewMoney,
  AgentViewObjectReference,
  AgentViewPaginationMeta,
} from "./shared";

/**
 * Which figure produced a connected-source position's value (PRD #328, #339):
 *  - `metal`/`numismatic`: a coin's frozen `max(metal, numismatic)` candidate.
 *  - `purchase`: the coin's recorded purchase price (the fallback when neither
 *    candidate is known).
 *  - `market`: a token's live `balance × unitPrice`.
 *  - `unvalued`: no value could be derived (an unpriced token or a coin with no
 *    candidate and no purchase price) — the position is reported at value 0 with
 *    a quality signal, never silently dropped.
 */
export type AgentViewPositionValuationBasis =
  | "metal"
  | "numismatic"
  | "purchase"
  | "market"
  | "unvalued";

/**
 * One connected-source position projected into a holding/rung (PRD #328, #339).
 * Polymorphic over the adapter via `kind`, but the agent-view shape is uniform:
 * a `quantity` (coin count or token balance, as a decimal string), an optional
 * `unitPrice` (known only for live-valued tokens), the derived `value`, and the
 * `valuationBasis` that produced it. The public `id` is derived from the source's
 * STABLE per-line id, so it survives a re-sync (PRD #328). Never carries a
 * credential, token, or raw provider payload.
 */
export interface AgentViewConnectedSourcePosition {
  id: string;
  object: "connected_source_position";
  kind: "coin" | "token";
  /** The provider tag (`numista` / `binance`). */
  adapter: string;
  /** The connected source's display label. */
  sourceLabel: string;
  /** The holding/rung this position projects into. */
  projectedHolding: AgentViewObjectReference;
  liquidityTier: AgentViewLiquidityTier;
  /** Display name for the line (coin name / token symbol). */
  label: string;
  /** Grouping metadata for the source-scoped lens: a coin's metal, a token's symbol. */
  groupKey: string | null;
  /** Coin count or token balance, as a decimal string. */
  quantity: string;
  /** Live unit price (decimal string), present only when a token price is known. */
  unitPrice?: string;
  value: AgentViewMoney;
  valuationBasis: AgentViewPositionValuationBasis;
  /** The valuing source's freshness, when the source has been valued. */
  freshness?: AgentViewSourceFreshnessSummary;
  /** Honest signals about the line (e.g. an unpriced token valued at 0). */
  qualitySignals: string[];
}

/**
 * One group of a source-scoped positions response (PRD #328, #339): the projected
 * holding/rung and the positions that landed in it, with the group's summed value.
 */
export interface AgentViewConnectedSourcePositionGroup {
  projectedHolding: AgentViewObjectReference;
  liquidityTier: AgentViewLiquidityTier;
  /** Summed value of the group's positions. */
  groupValue: AgentViewMoney;
  positions: AgentViewConnectedSourcePosition[];
}

/** Cursor-paginated connected-source positions for one holding/rung (PRD #328, #339). */
export interface AgentViewConnectedSourcePositionPage {
  positions: AgentViewConnectedSourcePosition[];
  meta: AgentViewPaginationMeta;
}

/**
 * Cursor-paginated connected-source positions for one source, grouped by their
 * projected holding/rung (PRD #328, #339). Pagination walks a stable
 * (holding, rung, position) order; a group can span page boundaries.
 */
export interface AgentViewConnectedSourcePositionGroupPage {
  groups: AgentViewConnectedSourcePositionGroup[];
  meta: AgentViewPaginationMeta;
}
