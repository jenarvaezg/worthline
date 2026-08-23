"use client";

import { formatRatioPct, returnsTooltipLines } from "@web/_components/returns-format";
import { holdingDetailHref } from "@web/holding-route";
import { PendingSubmit } from "@web/pending-submit";
import { boardRefreshHover } from "@web/price-refresh";
import { pushMirroredUrl, useViewStateSync } from "@web/url-view-state";
import type { TrashView } from "@worthline/db";
import type {
  BoardUnit,
  DomainWarning,
  HoldingReturnsView,
  PortfolioGroup,
  TrashExit,
  UnifiedHolding,
} from "@worthline/domain";
import { formatMoneyMinorPrivacy, trashExitLabel } from "@worthline/domain";
import Link from "next/link";
import {
  type FormEvent,
  useCallback,
  useOptimistic,
  useState,
  useTransition,
} from "react";
import {
  acknowledgeWarningAction,
  deleteAssetAction,
  deleteLiabilityAction,
  emptyTrashAction,
  hardDeleteAssetAction,
  hardDeleteLiabilityAction,
  restoreAssetAction,
  restoreLiabilityAction,
} from "./actions";
import {
  readOpenPortfoliosFromUrl,
  toggleOpenPortfolio,
  urlWithOpenPortfolios,
} from "./board-fold";
import {
  applyBoardMutations,
  type BoardModel,
  type BoardMutation,
} from "./optimistic-board";

/**
 * The /patrimonio holdings list (#271). A two-pane balance sheet: assets left,
 * liabilities right, physically separated so direction never needs a colour to be
 * read. The selected grouping axis (#154) becomes subsections inside each pane — on
 * the liquidity axis a mortgage sits opposite the home it secures. Each pane carries
 * a composition bar (by subsection, in rung colour) and every row a weight bar scaled
 * to its SECTION, so a dominant holding never flattens the smaller rungs into nothing.
 * A footer reconciles Activos − Pasivos = Patrimonio neto, and the Papelera is part
 * of that footer rather than a stray panel.
 *
 * A managed portfolio (#1548, ADR 0085) is ONE row of this board: collapsed it
 * is a summand like any other, expanded its members indent under a rail as a
 * breakdown — no bar of their own, because the bar is what says "this adds".
 * Σ rows = bruto therefore holds in both states, which is the whole point. The
 * header carries a chip so the row says what it is without being opened, the
 * caret opens it and the NAME links to the portfolio ficha (the door S1 built);
 * its weight bar is divided by member, so the inner split reads without opening
 * anything. The cuts are painted with a `linear-gradient` rather than child
 * elements: with the portfolio at 0,7 % of its section the bar is ~3px wide and
 * eight bordered children would need 8px — they would be clipped, showing three
 * arbitrary members. A gradient degrades on its own to the dominant colour.
 *
 * Optimistic mutations (#521, S5 of #485, interaction-patterns §4/§7/§8). This is the
 * ADR 0036 client island for the board: deleting a row (and emptying / hard-deleting
 * from the trash) shows immediately via `useOptimistic` folding the in-flight mutation
 * over the server model with the pure `applyBoardMutations`; the redirect every action
 * ends with re-renders server truth and settles it, or — on the error redirect —
 * reverts the optimistic change while the error band surfaces (§4). The forms keep a
 * plain server-action `action=` so they still work with JS off (progressive
 * enhancement); when JS is on, `onSubmit` intercepts to apply the optimistic merge in
 * a transition. The saving state is announced through a board-level `aria-live` region
 * (§8) — it lives OUTSIDE the optimistically-removed row, so the announcement is not
 * torn down with the row. In demo (`readOnly`) the optimism is skipped (§10): the
 * write-guard rejects the action, so a faked-then-reverted change would only flicker.
 */

type Currency = PortfolioGroup["totalMinor"]["currency"];

/** A holding's magnitude in minor units — value for an asset, balance for a debt. */
function magnitude(h: UnifiedHolding): number {
  return h.direction === "asset" ? h.valueMinor : h.balanceMinor;
}

/**
 * A fully-sold position: a derived (units × price) asset reading exactly 0
 * WITH recorded operations. The domain already blesses the derived 0 as
 * "correct, not an anomaly" (the ZERO_VALUE_ASSET warning exempts derived
 * holdings), and a derived 0 can ONLY mean no units — a priceless position
 * falls back to its cost basis, never to 0. A statement import with a real
 * sell history leaves dozens of these; they stay fully functional (ficha,
 * returns, history) behind the fold instead of burying the live portfolio.
 *
 * The operated-set guard is what separates "sold out" from "just created": a
 * brand-new investment also reads 0 until its first buy, and folding it away
 * the moment the user adds it would make it look lost. A manual/stored asset
 * at 0 stays in the list either way: for those, 0 IS the anomaly its warning
 * points at.
 */
function isClosedPosition(h: UnifiedHolding, operatedIds: ReadonlySet<string>): boolean {
  return (
    h.direction === "asset" &&
    h.valueIsDerived &&
    h.valueMinor === 0 &&
    operatedIds.has(h.id)
  );
}

function money(amountMinor: number, currency: Currency, privacyMode: boolean): string {
  return formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
}

/** The css custom property carrying a rung's identity colour (design-system §5). */
function tierVar(tier: UnifiedHolding["tier"]): string {
  return `var(--tier-${tier})`;
}

/**
 * A bar/segment fill: the rung's identity hue for an asset, the debit hue for a
 * pasivo (canon §6 — a debt speaks the debe colour, so red stays free for
 * movement). One place decides it, shared by the composition bars, weight bars
 * and subsection dots.
 */
function barColor(tier: UnifiedHolding["tier"], isAsset: boolean): string {
  return isAsset ? tierVar(tier) : "var(--debit-rule)";
}

/** Ownership label for household scope ("60 %" / "100 %"), or null outside household. */
function ownershipLabel(h: UnifiedHolding, isHousehold: boolean): string | null {
  if (!isHousehold) return null;
  const bps = h.ownership.totalShareBps;
  // Floor-cap the partial branch so 99.5–99.99 % never rounds up to "100 %" and
  // hides that the holding is co-owned (the whole reason the label exists).
  return bps < 10_000 ? `${Math.min(99, Math.round(bps / 100))} %` : "100 %";
}

/** Per-holding returns keyed by asset id (#551) — market investments only. */
/** Public `wl_hld_…` id per internal holding id — see {@link BalanceBoardProps}. */
type PublicIdByHolding = Readonly<Record<string, string>>;

type ReturnsById = ReadonlyMap<string, HoldingReturnsView>;

/**
 * The per-holding simple total gain, inline under the amount (#551, ADR 0040). The
 * gain is computed on the FULL position, so scale it to the row's scope share to
 * stay consistent with the (scope-weighted) value above it; the percentage is
 * share-invariant. Semantic gain/loss colour via the shared `.pos`/`.neg` tokens
 * (design-system §2), never raw green/red. The hover — a real focusable tooltip,
 * not a native `title` — explains the three measures and the honest caveats.
 */
function RowReturns({
  returns,
  shareBps,
  currency,
  privacyMode,
}: {
  returns: HoldingReturnsView;
  shareBps: number;
  currency: Currency;
  privacyMode: boolean;
}) {
  if (returns.totalReturnRatio === null) {
    return null;
  }
  const scaledGainMinor = Math.round((returns.totalGain.amountMinor * shareBps) / 10_000);
  const positive = returns.totalReturnRatio >= 0;
  const lines = returnsTooltipLines(returns);

  // The row is tabbable, so focusing it has to say what it is. On a bare div
  // (role `generic`) ARIA maps no author name: it took focus and announced
  // nothing. `group` is the role that carries the label (#1275).
  return (
    <div
      className={`balanceRowReturns returnsHint ${positive ? "pos" : "neg"}`}
      tabIndex={0}
      role="group"
      aria-label={`Rentabilidad: ${lines.join(". ")}`}
    >
      <span aria-hidden="true">{positive ? "▲" : "▼"}</span>{" "}
      {money(scaledGainMinor, currency, privacyMode)} ·{" "}
      {formatRatioPct(returns.totalReturnRatio)}
      <span className="returnsHintBody" role="tooltip">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </div>
  );
}

/**
 * Build an `onSubmit` that applies the optimistic merge before invoking the server
 * action, all inside a transition so `useOptimistic` tracks it and React keeps the
 * saving state pending until the action's redirect lands. `null` in demo, where the
 * form falls back to the plain server-action post (no faked optimism, §10).
 */
type OptimisticSubmit = (
  mutation: BoardMutation,
  action: (formData: FormData) => unknown,
) => ((event: FormEvent<HTMLFormElement>) => void) | undefined;

interface Section {
  key: string;
  label: string;
  tier: UnifiedHolding["tier"];
  /** The section's summands: loose rows and whole managed portfolios (#1548). */
  units: BoardUnit[];
}

/** A summand's magnitude — a block's is the sum of its members. */
function unitMagnitude(unit: BoardUnit): number {
  return unit.kind === "portfolio" ? unit.signedMinor : magnitude(unit.holding);
}

/** The rung a summand paints in — a block's is its dominant one. */
function unitTier(unit: BoardUnit): UnifiedHolding["tier"] {
  return unit.kind === "portfolio" ? unit.tier : unit.holding.tier;
}

/** A summand's label, for composition-bar hovers. */
function unitName(unit: BoardUnit): string {
  return unit.kind === "portfolio" ? unit.portfolio.name : unit.holding.name;
}

/**
 * One direction's holdings as labelled subsections. Sections keep the grouping-axis
 * order (ladder for Liquidez, first-seen for Instrumento); rows WITHIN a section are
 * sorted by amount, largest first. `.filter` already copies, so the sort never
 * mutates the projection.
 */
function sectionsFor(
  groups: PortfolioGroup[],
  direction: UnifiedHolding["direction"],
): Section[] {
  return groups
    .map((g) => {
      const units = g.units
        .filter((unit) =>
          unit.kind === "portfolio"
            ? direction === "asset"
            : unit.holding.direction === direction,
        )
        .sort((a, b) => unitMagnitude(b) - unitMagnitude(a));
      const first = units[0];
      return {
        key: g.key,
        label: g.label,
        tier: first ? unitTier(first) : "cash",
        units,
      };
    })
    .filter((s) => s.units.length > 0);
}

const sectionTotal = (units: BoardUnit[]) =>
  units.reduce((acc, unit) => acc + unitMagnitude(unit), 0);

/** Composition segments for a pane: by subsection when subdivided, else by holding. */
function paneSegments(sections: Section[], isAsset: boolean) {
  const denom = sections.reduce((acc, s) => acc + sectionTotal(s.units), 0) || 1;
  const color = (tier: UnifiedHolding["tier"]) => barColor(tier, isAsset);
  const segments =
    sections.length > 1
      ? sections.map((s) => ({
          key: s.key,
          value: sectionTotal(s.units),
          color: color(s.tier),
          label: s.label,
        }))
      : (sections[0]?.units ?? []).map((unit) => ({
          key: unit.key,
          value: unitMagnitude(unit),
          color: color(unitTier(unit)),
          label: unitName(unit),
        }));
  return { denom, segments };
}

function HoldingRow({
  holding,
  currency,
  isAsset,
  isHousehold,
  warnings,
  currentUrl,
  publicIdByHolding,
  sectionDenom,
  showTierLabel,
  nowIso,
  privacyMode,
  optimisticSubmit,
  returns,
  readOnly,
  banded,
}: {
  holding: UnifiedHolding;
  currency: Currency;
  isAsset: boolean;
  isHousehold: boolean;
  warnings: DomainWarning[];
  currentUrl: string;
  publicIdByHolding: PublicIdByHolding;
  sectionDenom: number;
  showTierLabel: boolean;
  nowIso: string;
  privacyMode: boolean;
  optimisticSubmit: OptimisticSubmit;
  returns: HoldingReturnsView | undefined;
  readOnly: boolean;
  /** Alternate rows band (canon §5, «papel rayado»). */
  banded: boolean;
}) {
  const h = holding;
  const rowWarnings = isAsset
    ? warnings.filter((w) => w.entityType === "asset" && w.entityId === h.id)
    : [];
  const ack = rowWarnings.find((w) => w.severity === "overrideable");
  const derived = h.direction === "asset" && h.valueIsDerived;
  // Enrich the derived-value badge's native hover with WHEN/WHO last priced it
  // (#303). Only an investment valued from the price cache carries this; null for
  // a manual-priced one, so the title stays just "Valor calculado (…)".
  const refreshHover =
    h.direction === "asset"
      ? boardRefreshHover(h.priceFetchedAt, h.priceSource, nowIso)
      : null;
  const own = ownershipLabel(h, isHousehold);
  const pct = (magnitude(h) / sectionDenom) * 100;
  const deleteAction = isAsset ? deleteAssetAction : deleteLiabilityAction;
  // The row is addressed by the holding's public `wl_hld_…` id (#1318): both the
  // ficha link and the anchor a mutation lands on. The internal id stays in the
  // hidden fields below, where it is storage plumbing and not a URL.
  //
  // A holding with no registry row cannot happen (every creation path mints one)
  // and there is deliberately no fallback to the internal id: linking to it would
  // re-open the leak this issue closed, for a URL that no longer resolves anyway.
  // The row still renders — with its name unlinked — so a registry gap costs one
  // door, not the whole board.
  const publicId = publicIdByHolding[h.id];
  const detailHref = publicId ? holdingDetailHref(publicId) : null;

  return (
    <div className={`balanceRow${banded ? " band" : ""}`} id={publicId ?? undefined}>
      <div className="balanceRowName">
        {detailHref ? <Link href={detailHref}>{h.name}</Link> : <span>{h.name}</span>}
        {rowWarnings.length > 0 ? (
          <span
            className="warningBadge"
            role="img"
            aria-label={rowWarnings[0]!.message}
            title={rowWarnings[0]!.message}
          >
            {" "}
            ⚠
          </span>
        ) : null}
        <div className="balanceRowSub">
          {showTierLabel && h.tierLabel ? <span>{h.tierLabel}</span> : null}
          {own ? <span>· {own}</span> : null}
        </div>
      </div>

      <div className="balanceRowAmount">
        {derived ? (
          <abbr
            className="balanceCalc"
            aria-label="Valor calculado"
            title={`Valor calculado (unidades × precio)${refreshHover ?? ""}`}
          >
            ≈
          </abbr>
        ) : null}
        {isAsset
          ? money(magnitude(h), currency, privacyMode)
          : `− ${money(magnitude(h), currency, privacyMode)}`}
        {isAsset && returns ? (
          <RowReturns
            currency={currency}
            privacyMode={privacyMode}
            returns={returns}
            shareBps={h.direction === "asset" ? h.ownership.totalShareBps : 10_000}
          />
        ) : null}
      </div>

      <details suppressHydrationWarning className="balanceActions">
        <summary aria-label={`Acciones para ${h.name}`}>⋯</summary>
        <div className="balanceMenu">
          {detailHref ? <Link href={detailHref}>Editar</Link> : null}
          {ack ? (
            <form action={acknowledgeWarningAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="code" type="hidden" value={ack.code} />
              <input name="entityId" type="hidden" value={h.id} />
              <button className="balanceMenuAck" disabled={readOnly} type="submit">
                Es intencional
              </button>
            </form>
          ) : null}
          <form
            action={deleteAction}
            onSubmit={optimisticSubmit({ kind: "delete", id: h.id }, deleteAction)}
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={h.id} />
            <details suppressHydrationWarning className="confirmDelete balanceMenuDelete">
              <summary>Eliminar</summary>
              <button disabled={readOnly} type="submit">
                Confirmar
              </button>
            </details>
          </form>
        </div>
      </details>

      <div className="balanceRowBar">
        <span
          style={{
            width: `${pct}%`,
            background: barColor(h.tier, isAsset),
          }}
        />
      </div>
    </div>
  );
}

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

/**
 * A managed portfolio as one row of the board, with its members folded under it
 * (#1548). Collapsed the header is the summand; expanded the members indent as
 * a breakdown that adds nothing — so the pane's total is the same either way.
 *
 * The caret toggles and the name links: if the whole name were the toggle, the
 * group would swallow the ficha door S1 built.
 */
function PortfolioBlock({
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

function Pane({
  title,
  total,
  currency,
  sections,
  closedRows = [],
  isAsset,
  isHousehold,
  warnings,
  currentUrl,
  publicIdByHolding,
  nowIso,
  privacyMode,
  optimisticSubmit,
  returnsById,
  readOnly,
  openPortfolios,
  onTogglePortfolio,
  publicIdByPortfolio,
}: {
  title: string;
  total: number;
  currency: Currency;
  sections: Section[];
  /** Fully-sold positions, folded at the pane's foot (assets pane only). */
  closedRows?: UnifiedHolding[];
  isAsset: boolean;
  isHousehold: boolean;
  warnings: DomainWarning[];
  currentUrl: string;
  publicIdByHolding: PublicIdByHolding;
  nowIso: string;
  privacyMode: boolean;
  optimisticSubmit: OptimisticSubmit;
  returnsById: ReturnsById;
  readOnly: boolean;
  /** Public ids of the portfolios rendered unfolded (#1548). */
  openPortfolios: ReadonlySet<string>;
  onTogglePortfolio: (publicId: string) => void;
  publicIdByPortfolio: PublicIdByHolding;
}) {
  const { denom, segments } = paneSegments(sections, isAsset);
  const showSubs = sections.length > 1;
  // Alternate rows band down the whole pane (canon §5); the cursor runs across
  // sections so the zebra never resets at a subsection header.
  let bandCursor = 0;

  return (
    <div
      className={`balancePane ${isAsset ? "balancePaneAsset" : "balancePaneDebt debitCol"}`}
    >
      <div className="balancePaneHead">
        <div className="balancePaneTop">
          <h3>{title}</h3>
          <span className="balancePaneTotal totalRule">
            {isAsset
              ? money(total, currency, privacyMode)
              : `− ${money(total, currency, privacyMode)}`}
          </span>
        </div>
        {segments.length > 0 ? (
          <div
            className="balanceCompBar"
            role="img"
            aria-label={`Composición de ${title}`}
          >
            {segments.map((s) => (
              <span
                className="balanceCompSeg"
                key={s.key}
                title={`${s.label} · ${money(s.value, currency, privacyMode)}`}
                style={{ width: `${(s.value / denom) * 100}%`, background: s.color }}
              />
            ))}
          </div>
        ) : null}
      </div>

      {sections.length === 0 && closedRows.length === 0 ? (
        <p className="balancePaneEmpty">{isAsset ? "Sin activos." : "Sin deudas."}</p>
      ) : (
        sections.map((s) => {
          const secDenom = sectionTotal(s.units) || 1;
          return (
            <div key={s.key}>
              {showSubs ? (
                <div className="balanceSub">
                  <span className="balanceSubLabel">
                    <span
                      className="balanceDot"
                      style={{
                        background: barColor(s.tier, isAsset),
                      }}
                    />
                    {s.label}
                  </span>
                  <span className="balanceSubTotal">
                    {money(secDenom, currency, privacyMode)}
                  </span>
                </div>
              ) : null}
              {s.units.map((unit) =>
                unit.kind === "portfolio" ? (
                  <PortfolioBlock
                    banded={bandCursor++ % 2 === 1}
                    currency={currency}
                    isHousehold={isHousehold}
                    key={unit.key}
                    onToggle={onTogglePortfolio}
                    open={openPortfolios.has(publicIdByPortfolio[unit.key] ?? "")}
                    privacyMode={privacyMode}
                    publicId={publicIdByPortfolio[unit.key] ?? null}
                    publicIdByHolding={publicIdByHolding}
                    sectionDenom={secDenom}
                    unit={unit}
                  />
                ) : (
                  <HoldingRow
                    banded={bandCursor++ % 2 === 1}
                    currency={currency}
                    currentUrl={currentUrl}
                    holding={unit.holding}
                    isAsset={isAsset}
                    isHousehold={isHousehold}
                    key={unit.key}
                    nowIso={nowIso}
                    optimisticSubmit={optimisticSubmit}
                    privacyMode={privacyMode}
                    publicIdByHolding={publicIdByHolding}
                    readOnly={readOnly}
                    returns={returnsById.get(unit.holding.id)}
                    sectionDenom={secDenom}
                    showTierLabel={!showSubs}
                    warnings={warnings}
                  />
                ),
              )}
            </div>
          );
        })
      )}

      {/* Fully-sold positions, folded like the Papelera: still first-class rows
          (ficha, realized returns, delete) — just not buried among the live
          ones. Their value is 0, so no sum or bar above changes. */}
      {closedRows.length > 0 ? (
        <details suppressHydrationWarning className="balanceClosed">
          <summary>Posiciones cerradas ({closedRows.length})</summary>
          {closedRows.map((h, index) => (
            <HoldingRow
              banded={index % 2 === 1}
              currency={currency}
              currentUrl={currentUrl}
              holding={h}
              isAsset={isAsset}
              isHousehold={isHousehold}
              key={h.id}
              nowIso={nowIso}
              optimisticSubmit={optimisticSubmit}
              privacyMode={privacyMode}
              publicIdByHolding={publicIdByHolding}
              readOnly={readOnly}
              returns={returnsById.get(h.id)}
              sectionDenom={1}
              showTierLabel={false}
              warnings={warnings}
            />
          ))}
        </details>
      ) : null}
    </div>
  );
}

function TrashRow({
  id,
  name,
  restoreAction,
  hardDeleteAction,
  currentUrl,
  optimisticSubmit,
  readOnly,
  trashExit = null,
}: {
  id: string;
  name: string;
  restoreAction: typeof restoreAssetAction;
  hardDeleteAction: typeof hardDeleteAssetAction;
  currentUrl: string;
  optimisticSubmit: OptimisticSubmit;
  readOnly: boolean;
  /** How the holding left the book, when the door recorded it (#1549). */
  trashExit?: TrashExit | null;
}) {
  return (
    <div className="balanceTrashRow">
      <span>
        {name}
        {/* The door's answer, said where the row now lives: «error de registro» is a
            declaration about the book, and a Papelera that does not repeat it turns
            the declaration into something only the database remembers. */}
        {trashExit ? (
          <small className="balanceTrashExit"> · {trashExitLabel(trashExit)}</small>
        ) : null}
      </span>
      <span className="balanceTrashRowActions">
        {/* Restore is NOT optimistic (§4): the board row it re-adds cannot be
            reconstructed from the trash's {id,name}, so faking it would show a wrong
            value. It stays a plain server-action post that re-renders on its redirect. */}
        <form action={restoreAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={id} />
          <PendingSubmit
            className="btnSmall"
            disabled={readOnly}
            pendingLabel="Restaurando…"
          >
            Restaurar
          </PendingSubmit>
        </form>
        <form
          action={hardDeleteAction}
          onSubmit={optimisticSubmit({ kind: "hardDelete", id }, hardDeleteAction)}
        >
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={id} />
          <details suppressHydrationWarning className="confirmDelete">
            <summary>Eliminar definitivamente</summary>
            <button disabled={readOnly} type="submit">
              Confirmar borrado definitivo
            </button>
          </details>
        </form>
      </span>
    </div>
  );
}

export interface BalanceBoardProps {
  groups: PortfolioGroup[];
  isHousehold: boolean;
  warnings: DomainWarning[];
  trash: TrashView;
  currentUrl: string;
  /**
   * Public `wl_hld_…` id per internal holding id (#1318) — the board is where a
   * holding becomes a link, so this is where the two id spaces meet.
   */
  publicIdByHolding: PublicIdByHolding;
  /**
   * Public `wl_prt_…` id per internal portfolio id (#1548) — the group header
   * is a link to the ficha and the fold param names portfolios in the URL.
   */
  publicIdByPortfolio?: PublicIdByHolding;
  /**
   * Portfolios rendered unfolded on the FIRST paint, read from the URL by the
   * server (#1548). Server-rendering the fold is what keeps a shared link from
   * flashing collapsed before hydration.
   */
  initialOpenPortfolios?: ReadonlySet<string>;
  /** Server render instant — anchors the derived-value badge's relative date (#303). */
  nowIso: string;
  privacyMode: boolean;
  /** Demo: skip optimistic state — the write-guard rejects, so optimism would flicker (§10). */
  readOnly?: boolean;
  /** Per-holding simple gain, keyed by asset id (#551); absent → no returns shown. */
  returnsById?: ReturnsById;
  /**
   * Asset ids with at least one recorded operation — the guard that separates a
   * fully-sold position (folds away) from a just-created one (stays visible).
   * Absent → nothing folds.
   */
  operatedAssetIds?: ReadonlySet<string>;
  /**
   * Render the Papelera already unfolded (#1365). The trashed-with-balance health
   * signal links here to repair the delete, and both repairs live INSIDE this
   * `<details>` — landing on a collapsed one shows the user nothing.
   */
  trashOpen?: boolean;
}

export default function BalanceBoard({
  groups,
  isHousehold,
  warnings,
  trash,
  currentUrl,
  publicIdByHolding,
  publicIdByPortfolio = {},
  initialOpenPortfolios,
  nowIso,
  privacyMode,
  readOnly = false,
  returnsById,
  operatedAssetIds,
  trashOpen = false,
}: BalanceBoardProps) {
  const returns: ReturnsById = returnsById ?? new Map();
  const base: BoardModel = { groups, trash };
  const [model, addPending] = useOptimistic(
    base,
    (current: BoardModel, mutation: BoardMutation) =>
      applyBoardMutations(current, [mutation]),
  );
  const [isPending, startTransition] = useTransition();

  // The fold is URL state (§3): the server paints the first frame from the
  // param, the island takes it from there and mirrors every toggle with
  // `pushState`, so Back closes what Forward opened and the link is shareable.
  // No navigation, no round-trip — folding a group re-reads nothing.
  const [openPortfolios, setOpenPortfolios] = useState<ReadonlySet<string>>(
    () => initialOpenPortfolios ?? new Set(),
  );
  const syncFoldFromUrl = useCallback(() => {
    setOpenPortfolios(readOpenPortfoliosFromUrl(window.location.href));
  }, []);
  useViewStateSync(syncFoldFromUrl);

  const togglePortfolio = (publicId: string) => {
    const next = toggleOpenPortfolio(openPortfolios, publicId);
    setOpenPortfolios(next);
    pushMirroredUrl(urlWithOpenPortfolios(window.location.href, next));
  };

  // Apply the optimistic merge, then run the action — both inside the transition so
  // `useOptimistic` tracks the change and `isPending` stays true until the action's
  // redirect lands. In demo we return undefined: the form falls back to its plain
  // `action=` post, which the write-guard rejects — no faked optimism (§10).
  const optimisticSubmit: OptimisticSubmit = (mutation, action) => {
    if (readOnly) {
      return undefined;
    }
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      startTransition(async () => {
        addPending(mutation);
        await action(formData);
      });
    };
  };

  const currency: Currency = model.groups[0]?.totalMinor.currency ?? "EUR";
  // Split fully-sold positions out of the live sections before building them —
  // they fold at the assets pane's foot instead. All 0 €, so no total changes.
  const operatedIds = operatedAssetIds ?? new Set<string>();
  // Only LOOSE rows fold away. A sold-out member stays inside its portfolio: the
  // block promises N positions and its 0 € member costs the total nothing, while
  // moving it out would make the header's count disagree with what unfolds.
  const closedRows = model.groups
    .flatMap((g) =>
      g.units.flatMap((unit) =>
        unit.kind === "holding" && isClosedPosition(unit.holding, operatedIds)
          ? [unit.holding]
          : [],
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const liveGroups = model.groups.map((g) => ({
    ...g,
    units: g.units.filter(
      (unit) => unit.kind === "portfolio" || !isClosedPosition(unit.holding, operatedIds),
    ),
  }));
  const assetSections = sectionsFor(liveGroups, "asset");
  const debtSections = sectionsFor(liveGroups, "liability");
  const grossAssets = assetSections.reduce((acc, s) => acc + sectionTotal(s.units), 0);
  const totalDebts = debtSections.reduce((acc, s) => acc + sectionTotal(s.units), 0);
  const net = grossAssets - totalDebts;
  const trashCount = model.trash.assets.length + model.trash.liabilities.length;

  if (groups.length === 0) {
    return (
      <section aria-label="Activos" className="balanceBoard">
        <p className="balanceEmpty">
          Sin activos todavía. <Link href="/patrimonio/anadir">Añadir activo →</Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Activos y pasivos" className="balanceBoard">
      {/* Announce the in-flight save for screen readers (§8). It sits at the board
          root — outside any optimistically-removed row — so the announcement is not
          torn down with the row it describes. The settled outcome is announced by the
          page's existing success/error band (role="status"/"alert") after the redirect. */}
      <p aria-live="polite" className="srOnly">
        {isPending ? "Guardando…" : ""}
      </p>

      <Pane
        closedRows={closedRows}
        currency={currency}
        currentUrl={currentUrl}
        isAsset
        isHousehold={isHousehold}
        nowIso={nowIso}
        onTogglePortfolio={togglePortfolio}
        openPortfolios={openPortfolios}
        optimisticSubmit={optimisticSubmit}
        privacyMode={privacyMode}
        publicIdByHolding={publicIdByHolding}
        publicIdByPortfolio={publicIdByPortfolio}
        readOnly={readOnly}
        returnsById={returns}
        sections={assetSections}
        title="Activos"
        total={grossAssets}
        warnings={warnings}
      />
      <Pane
        currency={currency}
        currentUrl={currentUrl}
        isAsset={false}
        isHousehold={isHousehold}
        nowIso={nowIso}
        onTogglePortfolio={togglePortfolio}
        openPortfolios={openPortfolios}
        optimisticSubmit={optimisticSubmit}
        privacyMode={privacyMode}
        publicIdByHolding={publicIdByHolding}
        publicIdByPortfolio={publicIdByPortfolio}
        readOnly={readOnly}
        returnsById={returns}
        sections={debtSections}
        title="Pasivos"
        total={totalDebts}
        warnings={warnings}
      />

      <div className="balanceRecon">
        <span className="balanceReconTitle">Balance</span>
        <div className="balanceReconFigures">
          <span className="balanceReconItem">
            <span className="balanceReconLabel">Activos</span>
            <span className="balanceReconValue">
              {money(grossAssets, currency, privacyMode)}
            </span>
          </span>
          <span className="balanceReconItem">
            <span className="balanceReconOp">−</span>
            <span className="balanceReconLabel">Pasivos</span>
            <span className="balanceReconValue">
              {money(totalDebts, currency, privacyMode)}
            </span>
          </span>
          <span className="balanceReconItem balanceReconNet">
            <span className="balanceReconOp">=</span>
            <span className="balanceReconLabel">Patrimonio neto</span>
            <span
              className={`balanceReconValue totalRule${net < 0 ? " balanceReconNeg" : ""}`}
            >
              {money(net, currency, privacyMode)}
            </span>
          </span>
        </div>
      </div>

      <details
        suppressHydrationWarning
        className="balanceTrash"
        id="papelera"
        open={trashOpen}
      >
        <summary>Papelera ({trashCount})</summary>
        {trashCount === 0 ? (
          <p className="balanceTrashEmpty">La papelera está vacía.</p>
        ) : (
          <div className="balanceTrashList">
            {model.trash.assets.map((item) => (
              <TrashRow
                currentUrl={currentUrl}
                hardDeleteAction={hardDeleteAssetAction}
                id={item.id}
                key={item.id}
                name={item.name}
                optimisticSubmit={optimisticSubmit}
                readOnly={readOnly}
                restoreAction={restoreAssetAction}
                trashExit={item.trashExit ?? null}
              />
            ))}
            {model.trash.liabilities.map((item) => (
              <TrashRow
                currentUrl={currentUrl}
                hardDeleteAction={hardDeleteLiabilityAction}
                id={item.id}
                key={item.id}
                name={item.name}
                optimisticSubmit={optimisticSubmit}
                readOnly={readOnly}
                restoreAction={restoreLiabilityAction}
              />
            ))}
          </div>
        )}
        {trashCount > 0 ? (
          <form
            action={emptyTrashAction}
            className="balanceTrashEmptyAll"
            onSubmit={optimisticSubmit({ kind: "emptyTrash" }, emptyTrashAction)}
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <details suppressHydrationWarning className="confirmDelete">
              <summary>Vaciar papelera</summary>
              <button disabled={readOnly} type="submit">
                Confirmar vaciado de papelera
              </button>
            </details>
          </form>
        ) : null}
      </details>
    </section>
  );
}
