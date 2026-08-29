/**
 * The board's shared vocabulary: how a holding's magnitude, its colour and its
 * ownership label are read (#271, #1608).
 *
 * Every surface of the balance sheet — the row, the portfolio block, the pane's
 * composition bar, the subsection dot — has to agree on these or the paper stops
 * reconciling: two modules deciding a rung's colour on their own is how a debt
 * ends up speaking the credit hue in one place and the debit hue in another.
 * Pure functions, no React, so the split is a vocabulary and not a component.
 */

import type {
  HoldingReturnsView,
  PortfolioGroup,
  UnifiedHolding,
} from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";

export type Currency = PortfolioGroup["totalMinor"]["currency"];

/**
 * Public `wl_hld_…` / `wl_prt_…` id per internal id (#1318) — the board is where
 * a holding becomes a link, so this is where the two id spaces meet.
 */
export type PublicIdByInternalId = Readonly<Record<string, string>>;

/** Per-holding returns keyed by asset id (#551) — market investments only. */
export type ReturnsById = ReadonlyMap<string, HoldingReturnsView>;

/** A holding's magnitude in minor units — value for an asset, balance for a debt. */
export function magnitude(h: UnifiedHolding): number {
  return h.direction === "asset" ? h.valueMinor : h.balanceMinor;
}

export function money(
  amountMinor: number,
  currency: Currency,
  privacyMode: boolean,
): string {
  return formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
}

/** The css custom property carrying a rung's identity colour (design-system §5). */
export function tierVar(tier: UnifiedHolding["tier"]): string {
  return `var(--tier-${tier})`;
}

/**
 * A bar/segment fill: the rung's identity hue for an asset, the debit hue for a
 * pasivo (canon §6 — a debt speaks the debe colour, so red stays free for
 * movement). One place decides it, shared by the composition bars, weight bars
 * and subsection dots.
 */
export function barColor(tier: UnifiedHolding["tier"], isAsset: boolean): string {
  return isAsset ? tierVar(tier) : "var(--debit-rule)";
}

/** Ownership label for household scope ("60 %" / "100 %"), or null outside household. */
export function ownershipLabel(h: UnifiedHolding, isHousehold: boolean): string | null {
  if (!isHousehold) return null;
  const bps = h.ownership.totalShareBps;
  // Floor-cap the partial branch so 99.5–99.99 % never rounds up to "100 %" and
  // hides that the holding is co-owned (the whole reason the label exists).
  return bps < 10_000 ? `${Math.min(99, Math.round(bps / 100))} %` : "100 %";
}
