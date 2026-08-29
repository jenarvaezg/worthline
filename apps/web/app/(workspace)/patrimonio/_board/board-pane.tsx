"use client";

/**
 * One side of the balance sheet: Activos or Pasivos (#271, #1608).
 *
 * A pane carries a composition bar (by subsection when the grouping axis
 * subdivides it, else by holding, in rung colour) and then its sections, each
 * summand rendered by the module that owns its shape — a loose row by
 * `HoldingRow`, a managed portfolio by `PortfolioBlock`. The pane decides WHERE
 * a summand goes and how heavy it reads; it never decides what a summand looks
 * like, which is why a new kind of summand adds a module here instead of a
 * branch.
 */

import {
  barColor,
  type Currency,
  money,
  type PublicIdByInternalId,
  type ReturnsById,
} from "@web/patrimonio/_board/board-format";
import {
  paneSegments,
  type Section,
  sectionTotal,
} from "@web/patrimonio/_board/board-sections";
import { HoldingRow } from "@web/patrimonio/_board/holding-row";
import { PortfolioBlock } from "@web/patrimonio/_board/portfolio-block";
import type { OptimisticSubmit } from "@web/patrimonio/_board/use-optimistic-board";
import type { DomainWarning, UnifiedHolding } from "@worthline/domain";

export function Pane({
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
  publicIdByHolding: PublicIdByInternalId;
  nowIso: string;
  privacyMode: boolean;
  optimisticSubmit: OptimisticSubmit;
  returnsById: ReturnsById;
  readOnly: boolean;
  /** Public ids of the portfolios rendered unfolded (#1548). */
  openPortfolios: ReadonlySet<string>;
  onTogglePortfolio: (publicId: string) => void;
  publicIdByPortfolio: PublicIdByInternalId;
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
