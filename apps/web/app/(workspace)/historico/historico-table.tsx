/**
 * Histórico drill table (#270). Each day is a lean row — date · net worth · Δ —
 * that expands (native `<details>`, ADR 0009 zero-client-JS) into a breakdown of
 * which holdings moved the net worth and by how much, reconciling to the day's Δ.
 *
 * The two derivations behind it are pure domain functions, tested there:
 * `deriveConfirmedMonthlyCloseIds` (which days are real "Cierre de mes") and
 * `deriveHoldingDeltas` (the per-holding contributions). This module is the thin
 * view assembly + presentation over the frozen holding rows (ADR 0008).
 */

import type { SnapshotHoldingRecord } from "@worthline/db";
import type {
  HoldingDelta,
  LiquidityTier,
  MoneyMinor,
  NetWorthSnapshot,
  PositionDelta,
} from "@worthline/domain";
import {
  deriveConfirmedMonthlyCloseIds,
  deriveHoldingDeltas,
  derivePositionDeltas,
  formatMoneyMinorPrivacy,
  moneySign,
} from "@worthline/domain";
import { Fragment } from "react";

/**
 * A per-holding mover, optionally carrying its per-position movers (ADR 0035) —
 * the second drilldown level for a connected-source holding that froze a
 * breakdown. Plain holdings carry none.
 */
export interface HistoricoMover extends HoldingDelta {
  positions?: PositionDelta[];
}

export interface HistoricoRow {
  snapshot: NetWorthSnapshot;
  delta?: MoneyMinor;
  movers: HistoricoMover[];
  isMonthlyClose: boolean;
}

/**
 * The histórico renders whole euros (formatMoneyMinor, maximumFractionDigits 0), so
 * a contribution under ±0,50 € shows as "0 €". A per-position mover that small is
 * noise — a coin/token that "did not change" at display precision (e.g. a backfilled
 * snapshot's proportional sub-€ slice, PRD #459) — so it is dropped from the second
 * drilldown level. The holding's own Δ still reflects every sub-€ slice.
 */
function showsAsZeroEur(contributionMinor: number): boolean {
  return Math.round(contributionMinor / 100) === 0;
}

/**
 * Assemble the newest-first rows the table renders: aggregate Δ vs the previous
 * day, the confirmed monthly-close flag, and the per-holding movers behind each
 * day's change. `today` ("YYYY-MM-DD") drives the monthly-close correction.
 */
export function buildHistoricoRows(
  snapshots: readonly NetWorthSnapshot[],
  holdingRecords: readonly SnapshotHoldingRecord[],
  today: string,
): HistoricoRow[] {
  const closes = deriveConfirmedMonthlyCloseIds(snapshots, today);

  const bySnapshot = new Map<string, SnapshotHoldingRecord[]>();
  for (const rec of holdingRecords) {
    const list = bySnapshot.get(rec.snapshotId);
    if (list) list.push(rec);
    else bySnapshot.set(rec.snapshotId, [rec]);
  }

  return snapshots
    .map((snapshot, idx) => {
      const prev = snapshots[idx - 1];
      const delta = prev
        ? {
            amountMinor:
              snapshot.totalNetWorth.amountMinor - prev.totalNetWorth.amountMinor,
            currency: snapshot.totalNetWorth.currency,
          }
        : undefined;
      const prevRecs = prev ? (bySnapshot.get(prev.id) ?? []) : [];
      const curRecs = bySnapshot.get(snapshot.id) ?? [];
      // Enrich each holding mover with its per-position movers (ADR 0035), derived
      // from the two days' frozen position rows. A connected holding that froze a
      // breakdown gets a second level; a plain holding gets none.
      const movers: HistoricoMover[] = (
        prev ? deriveHoldingDeltas(prevRecs, curRecs) : []
      ).map((mover) => {
        const positions = derivePositionDeltas(
          prevRecs.find((r) => r.holdingId === mover.holdingId)?.positions ?? [],
          curRecs.find((r) => r.holdingId === mover.holdingId)?.positions ?? [],
        ).filter((p) => !showsAsZeroEur(p.contributionMinor));
        return positions.length > 0 ? { ...mover, positions } : mover;
      });
      return {
        snapshot,
        movers,
        isMonthlyClose: closes.has(snapshot.id),
        ...(delta ? { delta } : {}),
      };
    })
    .reverse();
}

function money(amountMinor: number, currency: string): MoneyMinor {
  return { amountMinor, currency };
}

/** formatMoneyMinorPrivacy with an explicit "+" on gains, as the design system asks of deltas. */
function formatSigned(value: MoneyMinor, privacyMode: boolean): string {
  const text = formatMoneyMinorPrivacy(value, privacyMode);
  return value.amountMinor > 0 ? `+${text}` : text;
}

function TierDot({ tier }: { tier: LiquidityTier | null }) {
  return <span className={`tierDot tierDot--${tier ?? "none"}`} aria-hidden="true" />;
}

/**
 * The second drilldown level (ADR 0035): a connected holding's per-coin movers,
 * each with its image (a metal-glyph fallback when the catalogue has none, like
 * the live coin gallery), label, and signed € contribution. Zero-JS (ADR 0009).
 */
function PositionMovers({
  positions,
  currency,
  privacyMode,
}: {
  positions: PositionDelta[];
  currency: string;
  privacyMode: boolean;
}) {
  return (
    <div className="historicoPositionBridge">
      {positions.map((p) => {
        const sign = moneySign({ amountMinor: p.contributionMinor, currency });
        return (
          <div key={p.positionKey} className="historicoPositionRow">
            <span className="historicoPositionLabel">
              <span className="historicoPositionThumb">
                {p.imageUrl ? (
                  // A remote Numista CDN thumb, server-rendered (ADR 0009); no
                  // next/image optimizer for an external, list-scale image.
                  // biome-ignore lint/performance/noImgElement: remote Numista CDN thumb (ADR 0009)
                  <img
                    alt=""
                    className="coinThumbImg"
                    height={24}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    src={p.imageUrl}
                    width={24}
                  />
                ) : (
                  <span className="coinThumbFallback" aria-hidden="true" />
                )}
              </span>
              <span className="historicoPositionName">{p.label}</span>
              {p.status !== "changed" ? (
                <em className="historicoMoverTag">
                  {p.status === "new" ? "nuevo" : "salió"}
                </em>
              ) : null}
            </span>
            <span className={`numCol ${sign}`}>
              {formatSigned({ amountMinor: p.contributionMinor, currency }, privacyMode)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function HistoricoTable({
  rows,
  privacyMode = false,
}: {
  rows: HistoricoRow[];
  privacyMode?: boolean;
}) {
  // Rows are newest-first; a year cut (canon §5b) is a heavy rule printed BETWEEN
  // two years, so it opens each older year block — never above the newest one,
  // which the section's own opening rule + column head already top.
  let previousYear: string | null = null;

  return (
    <div className="historicoDrill">
      <div className="historicoDrillHead">
        <span>Fecha</span>
        <span className="numCol">Patrimonio neto</span>
        <span className="numCol">Δ vs anterior</span>
        <span />
      </div>
      {rows.map(({ snapshot, delta, movers, isMonthlyClose }) => {
        const currency = snapshot.totalNetWorth.currency;
        const year = snapshot.dateKey.slice(0, 4);
        const showYearRule = previousYear !== null && year !== previousYear;
        previousYear = year;
        const deltaSign = delta ? moneySign(delta) : undefined;
        const maxAbs = movers.reduce(
          (max, m) => Math.max(max, Math.abs(m.contributionMinor)),
          0,
        );

        return (
          <Fragment key={snapshot.id}>
            {showYearRule ? <div className="historicoYearRule">{year}</div> : null}
            <details
              className={`historicoDrillRow${isMonthlyClose ? " monthlyClose" : ""}`}
            >
              <summary>
                <span className="dateCell">
                  <span className="dateKey">{snapshot.dateKey}</span>
                  {isMonthlyClose ? (
                    <span className="monthlyCloseBadge">Cierre de mes</span>
                  ) : null}
                </span>
                <span className={`numCol ${moneySign(snapshot.totalNetWorth)}`}>
                  {formatMoneyMinorPrivacy(snapshot.totalNetWorth, privacyMode)}
                </span>
                <span className={`numCol ${deltaSign ?? ""}`}>
                  {delta ? formatSigned(delta, privacyMode) : "—"}
                </span>
                <span className="historicoDrillCue" aria-hidden="true">
                  {movers.length > 0 ? `${movers.length} ▾` : ""}
                </span>
              </summary>
              <div className="historicoBridge">
                {movers.length === 0 ? (
                  <p className="historicoMuted">
                    {delta
                      ? "Sin movimiento de holdings este día."
                      : "Primera captura — sin día anterior con el que comparar."}
                  </p>
                ) : (
                  movers.map((m) => {
                    const sign = moneySign(money(m.contributionMinor, currency));
                    const width =
                      maxAbs > 0
                        ? Math.max(
                            3,
                            Math.round((Math.abs(m.contributionMinor) / maxAbs) * 100),
                          )
                        : 0;
                    const label = (
                      <span className="historicoBridgeLabel">
                        <TierDot tier={m.liquidityTier} />
                        {m.label}
                        {m.status !== "changed" ? (
                          <em className="historicoMoverTag">
                            {m.status === "new" ? "nuevo" : "salió"}
                          </em>
                        ) : null}
                        {m.positions ? (
                          <span className="historicoMoverCue" aria-hidden="true">
                            {m.positions.length} ▾
                          </span>
                        ) : null}
                      </span>
                    );
                    const track = (
                      <span className="historicoBridgeTrack">
                        <i
                          className={`historicoBridgeFill ${sign}`}
                          style={{ width: `${width}%` }}
                        />
                      </span>
                    );
                    const amount = (
                      <span className={`numCol ${sign}`}>
                        {formatSigned(money(m.contributionMinor, currency), privacyMode)}
                      </span>
                    );

                    // A plain holding: a single bridge row. A connected holding that
                    // froze a per-position breakdown (ADR 0035): the same row becomes
                    // a native <details> (zero-JS, ADR 0009) that opens its per-coin
                    // movers — the second drilldown level.
                    if (!m.positions) {
                      return (
                        <div key={m.holdingId} className="historicoBridgeRow">
                          {label}
                          {track}
                          {amount}
                        </div>
                      );
                    }
                    return (
                      <details key={m.holdingId} className="historicoMoverDetails">
                        <summary className="historicoBridgeRow historicoMoverSummary">
                          {label}
                          {track}
                          {amount}
                        </summary>
                        <PositionMovers
                          positions={m.positions}
                          currency={currency}
                          privacyMode={privacyMode}
                        />
                      </details>
                    );
                  })
                )}
                {movers.length > 0 && delta ? (
                  <div className="historicoBridgeFoot">
                    <span>Σ contribuciones</span>
                    <span className={`numCol ${deltaSign ?? ""}`}>
                      {formatSigned(delta, privacyMode)}
                    </span>
                  </div>
                ) : null}
              </div>
            </details>
          </Fragment>
        );
      })}
    </div>
  );
}
