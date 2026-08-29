"use client";

/**
 * A managed portfolio as ONE row of the board, with its members folded under it
 * (#1548, ADR 0085; own module since #1608).
 *
 * Collapsed the header is a summand like any other; expanded its members indent
 * under a rail as a breakdown with no bar of their own — because the bar is what
 * says "this adds". Σ rows = bruto therefore holds in both states, which is the
 * whole point. The header carries a chip so the row says what it is without being
 * opened, the caret opens it and the NAME links to the portfolio ficha: if the
 * whole name were the toggle, the group would swallow the door S1 built.
 */

import { holdingDetailHref } from "@web/holding-route";
import {
  type Currency,
  magnitude,
  money,
  ownershipLabel,
  type PublicIdByHolding,
  tierVar,
} from "@web/patrimonio/_board/board-format";
import type { BoardUnit, UnifiedHolding } from "@worthline/domain";
import Link from "next/link";

/**
 * The weight bar of a portfolio block, cut by member (#1548).
 *
 * A `linear-gradient` with hard stops rather than child elements: the bar's
 * width is the block's weight in its section, which on the Activos/Pasivos axis
 * can be ~3px — eight children with a 1px separator each would need 8px and get
 * clipped, showing three members chosen by order instead of by size. A gradient
 * has nothing to clip: at 3px it degrades to the dominant colour, at full width
 * every cut is there. Each member keeps ITS OWN rung colour (design-system §5);
 * the cuts are hairlines of the paper, never a decorative ramp.
 */
function memberGradient(members: readonly UnifiedHolding[], totalMinor: number): string {
  if (totalMinor <= 0 || members.length === 0) {
    return "var(--tier-market)";
  }
  const stops: string[] = [];
  const at = (value: number) => `${Math.round(value * 100) / 100}%`;
  let cursor = 0;
  members.forEach((member, index) => {
    const start = cursor;
    cursor += (magnitude(member) / totalMinor) * 100;
    // A hairline of paper between members — in percent, so it shrinks with the
    // bar instead of eating it.
    const from = index > 0 ? Math.min(start + 0.6, cursor) : start;
    if (index > 0) {
      stops.push(`var(--panel) ${at(start)} ${at(from)}`);
    }
    stops.push(`${tierVar(member.tier)} ${at(from)} ${at(cursor)}`);
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

export function PortfolioBlock({
  unit,
  currency,
  isHousehold,
  open,
  onToggle,
  publicId,
  publicIdByHolding,
  sectionDenom,
  privacyMode,
  banded,
}: {
  unit: Extract<BoardUnit, { kind: "portfolio" }>;
  currency: Currency;
  isHousehold: boolean;
  open: boolean;
  onToggle: (publicId: string) => void;
  /** The portfolio's public `wl_prt_…` id, or null when it has no registry row. */
  publicId: string | null;
  publicIdByHolding: PublicIdByHolding;
  sectionDenom: number;
  privacyMode: boolean;
  banded: boolean;
}) {
  const total = unit.signedMinor;
  const pct = (total / (sectionDenom || 1)) * 100;
  const label = `${unit.members.length} ${unit.members.length === 1 ? "posición" : "posiciones"}`;

  return (
    <>
      <div className={`balanceRow${banded ? " band" : ""}`} id={publicId ?? undefined}>
        <div className="balanceRowName">
          <span className="balanceGroupName">
            <button
              aria-controls={publicId ? `${publicId}-miembros` : undefined}
              aria-expanded={open}
              className="balanceGroupCaret"
              disabled={publicId === null}
              onClick={() => publicId && onToggle(publicId)}
              type="button"
            >
              <span aria-hidden="true">{open ? "▾" : "▸"}</span>
              <span className="srOnly">
                {open
                  ? `Colapsar ${unit.portfolio.name}`
                  : `Desplegar ${unit.portfolio.name}`}
              </span>
            </button>
            {publicId ? (
              <Link href={`/patrimonio/carteras/${publicId}`}>{unit.portfolio.name}</Link>
            ) : (
              <span>{unit.portfolio.name}</span>
            )}
          </span>
          <div className="balanceRowSub">
            <span className="balanceGroupChip">cartera</span>
            {unit.portfolio.provider ? <span>{unit.portfolio.provider}</span> : null}
            <span>· {label}</span>
          </div>
        </div>

        <div className="balanceRowAmount">{money(total, currency, privacyMode)}</div>
        <span aria-hidden="true" className="balanceGroupSpacer" />

        <div className="balanceRowBar">
          <span
            style={{
              background: memberGradient(unit.members, total),
              width: `${pct}%`,
            }}
          />
        </div>
      </div>

      {open ? (
        <div
          className="balanceGroupMembers"
          id={publicId ? `${publicId}-miembros` : undefined}
        >
          {/* The same split, rescaled to the portfolio's own 100 % — the scale in
              which the members' weights below can be checked by eye. */}
          <div
            aria-hidden="true"
            className="balanceGroupSplit"
            style={{ background: memberGradient(unit.members, total) }}
          />
          {unit.members.map((member) => {
            const memberPublicId = publicIdByHolding[member.id];
            const share = total > 0 ? (magnitude(member) / total) * 100 : 0;
            const own = ownershipLabel(member, isHousehold);
            return (
              <div className="balanceGroupMember" key={member.id}>
                <span className="balanceGroupMemberName">
                  {memberPublicId ? (
                    <Link href={holdingDetailHref(memberPublicId)}>{member.name}</Link>
                  ) : (
                    member.name
                  )}
                  {own ? <span className="balanceRowSub"> · {own}</span> : null}
                </span>
                <span className="balanceGroupMemberShare">
                  {share.toFixed(1).replace(".", ",")} %
                </span>
                <span className="balanceGroupMemberAmount">
                  {money(magnitude(member), currency, privacyMode)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
