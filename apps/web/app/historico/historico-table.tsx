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

import type {
  HoldingDelta,
  LiquidityTier,
  MoneyMinor,
  NetWorthSnapshot,
} from "@worthline/domain";
import {
  deriveConfirmedMonthlyCloseIds,
  deriveHoldingDeltas,
  formatMoneyMinor,
  moneySign,
} from "@worthline/domain";
import type { SnapshotHoldingRecord } from "@worthline/db";

export interface HistoricoRow {
  snapshot: NetWorthSnapshot;
  delta?: MoneyMinor;
  movers: HoldingDelta[];
  isMonthlyClose: boolean;
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
      const movers = prev
        ? deriveHoldingDeltas(
            bySnapshot.get(prev.id) ?? [],
            bySnapshot.get(snapshot.id) ?? [],
          )
        : [];
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

/** formatMoneyMinor with an explicit "+" on gains, as the design system asks of deltas. */
function formatSigned(value: MoneyMinor): string {
  const text = formatMoneyMinor(value);
  return value.amountMinor > 0 ? `+${text}` : text;
}

function TierDot({ tier }: { tier: LiquidityTier | null }) {
  return <span className={`tierDot tierDot--${tier ?? "none"}`} aria-hidden="true" />;
}

export function HistoricoTable({ rows }: { rows: HistoricoRow[] }) {
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
        const deltaSign = delta ? moneySign(delta) : undefined;
        const maxAbs = movers.reduce(
          (max, m) => Math.max(max, Math.abs(m.contributionMinor)),
          0,
        );

        return (
          <details
            key={snapshot.id}
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
                {formatMoneyMinor(snapshot.totalNetWorth)}
              </span>
              <span className={`numCol ${deltaSign ?? ""}`}>
                {delta ? formatSigned(delta) : "—"}
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
                  return (
                    <div key={m.holdingId} className="historicoBridgeRow">
                      <span className="historicoBridgeLabel">
                        <TierDot tier={m.liquidityTier} />
                        {m.label}
                        {m.status !== "changed" ? (
                          <em className="historicoMoverTag">
                            {m.status === "new" ? "nuevo" : "salió"}
                          </em>
                        ) : null}
                      </span>
                      <span className="historicoBridgeTrack">
                        <i
                          className={`historicoBridgeFill ${sign}`}
                          style={{ width: `${width}%` }}
                        />
                      </span>
                      <span className={`numCol ${sign}`}>
                        {formatSigned(money(m.contributionMinor, currency))}
                      </span>
                    </div>
                  );
                })
              )}
              {movers.length > 0 && delta ? (
                <div className="historicoBridgeFoot">
                  <span>Σ contribuciones</span>
                  <span className={`numCol ${deltaSign ?? ""}`}>
                    {formatSigned(delta)}
                  </span>
                </div>
              ) : null}
            </div>
          </details>
        );
      })}
    </div>
  );
}
