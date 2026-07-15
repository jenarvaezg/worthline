import { resolveMaintainerAlertAction } from "@web/admin/resolve-maintainer-alert-action";
import type { AgentViewCalculationTrace, AgentViewMoney } from "@web/agent-view/contract";
import {
  type MaintainerAlertPayload,
  maintainerAlertCategoryLabel,
} from "@web/asistente/maintainer-alert";
import type {
  MaintainerAlertStatus,
  MaintainerAlertWithOccurrences,
} from "@worthline/db";
import { formatMoneyMinor } from "@worthline/domain";

/**
 * The forensic detail of one maintainer alert (#1050, ADR 0064): the trace
 * tabulated like a bank's cuadro (declared-vs-computed), the config snapshot,
 * the structured data extracted from the document, a conversation pointer, and
 * the close (resolve/dismiss) form. Paper surface, rendered behind `guardAdmin`.
 * Every field is defensive: a partial/malformed payload degrades to "—" rather
 * than crashing the admin surface.
 */

function statusLabel(status: MaintainerAlertStatus): string {
  switch (status) {
    case "open":
      return "Abierta";
    case "resolved":
      return "Resuelta";
    case "dismissed":
      return "Descartada";
  }
}

function money(value: AgentViewMoney | null | undefined): string {
  if (!value || typeof value.amountMinor !== "number") return "—";
  return formatMoneyMinor({ amountMinor: value.amountMinor, currency: value.currency });
}

/**
 * Whether a stored trace payload has the shape this view dereferences. The
 * payload is opaque forensic JSON frozen at raise time (control-plane.ts), so a
 * later change to `AgentViewCalculationTrace` — or a truncated/corrupted row —
 * must degrade to the raw JSON, never crash the whole /admin detail page.
 */
function isRenderableTrace(trace: AgentViewCalculationTrace | null): boolean {
  if (!trace || typeof trace !== "object") return false;
  const fidelity = (trace as { fidelity?: unknown }).fidelity;
  const tolerance = (trace as { tolerance?: unknown }).tolerance;
  return (
    typeof fidelity === "object" &&
    fidelity !== null &&
    typeof tolerance === "object" &&
    tolerance !== null &&
    Array.isArray((trace as { reconciliation?: unknown }).reconciliation)
  );
}

/** The trace tabulated like a bank cuadro (#1050): reconciliation + amortization schedule. */
function CalculationTraceView({ trace }: { trace: AgentViewCalculationTrace }) {
  return (
    <div className="alertTrace">
      <p className="alertMeta">
        Modelo <strong>{trace.model}</strong> · saldo pintado {money(trace.currentValue)}{" "}
        · fidelidad <strong>{trace.fidelity.faithful ? "fiel" : "INFIEL"}</strong> (
        {trace.fidelity.checkedPoints} puntos comprobados)
      </p>

      {trace.tolerance.declared ? (
        <p className="alertMeta">
          Declarado {money(trace.tolerance.declared.balance)} el{" "}
          {trace.tolerance.declared.date} vs vivo — residuo{" "}
          <strong>{money(trace.tolerance.declared.residual)}</strong> · banda{" "}
          {money(trace.tolerance.band)} ·{" "}
          {trace.tolerance.declared.withinTolerance
            ? "dentro de tolerancia"
            : "FUERA de tolerancia"}
        </p>
      ) : (
        <p className="alertMeta">
          Banda de tolerancia {money(trace.tolerance.band)} sobre{" "}
          {money(trace.tolerance.referenceBalance)} ({trace.tolerance.referenceDate})
        </p>
      )}

      <h3>Reconciliación (vivo vs persistido)</h3>
      <table className="alertTable">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Vivo</th>
            <th>Persistido</th>
            <th>Diferencia</th>
            <th>Diverge</th>
          </tr>
        </thead>
        <tbody>
          {trace.reconciliation.map((point) => (
            <tr key={point.date} className={point.diverges ? "alertDiverges" : undefined}>
              <td>{point.date}</td>
              <td>{money(point.live)}</td>
              <td>{money(point.persisted)}</td>
              <td>{money(point.difference)}</td>
              <td>{point.diverges ? "sí" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {trace.omittedReconciliationPoints > 0 ? (
        <p className="alertMeta">
          {trace.omittedReconciliationPoints} punto(s) más allá del tope no reconciliados.
        </p>
      ) : null}

      {trace.schedule && Array.isArray(trace.schedule.frontiers) ? (
        <>
          <h3>Cuadro de amortización</h3>
          <p className="alertMeta">
            Capital inicial {money(trace.schedule.initialCapital)} · plazo{" "}
            {trace.schedule.termMonths} meses · efectivo desde{" "}
            {trace.schedule.effectiveFrom}
          </p>
          <table className="alertTable">
            <thead>
              <tr>
                <th>#</th>
                <th>Fecha</th>
                <th>Apertura</th>
                <th>Cuota</th>
                <th>Interés</th>
                <th>Principal</th>
                <th>Cierre</th>
              </tr>
            </thead>
            <tbody>
              {trace.schedule.frontiers.map((frontier) => (
                <tr key={frontier.index}>
                  <td>{frontier.index}</td>
                  <td>{frontier.date}</td>
                  <td>{money(frontier.openingBalance)}</td>
                  <td>{money(frontier.payment)}</td>
                  <td>{money(frontier.interest)}</td>
                  <td>{money(frontier.principal)}</td>
                  <td>{money(frontier.closingBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}

function OccurrenceView({
  payload,
  occurredAt,
  index,
}: {
  payload: MaintainerAlertPayload | null;
  occurredAt: string;
  index: number;
}) {
  return (
    <article className="alertOccurrence">
      <h3>
        Ocurrencia {index + 1} · {occurredAt}
      </h3>
      {payload === null ? (
        <p className="alertMeta">Payload ilegible.</p>
      ) : (
        <>
          {payload.summary ? <p className="alertSummary">{payload.summary}</p> : null}
          {payload.holding ? (
            <p className="alertMeta">
              {payload.holding.label} · {payload.holding.instrument} ·{" "}
              {payload.holding.valuationMethod} ({payload.holding.id})
            </p>
          ) : null}
          {payload.declared ? (
            <p className="alertMeta">
              Cifra declarada:{" "}
              {money({
                amountMinor: payload.declared.balanceMinor,
                currency: payload.declared.currency,
              })}{" "}
              el {payload.declared.date} — fuente: {payload.declared.source}
            </p>
          ) : null}
          {payload.calculationTrace ? (
            isRenderableTrace(payload.calculationTrace) ? (
              <CalculationTraceView trace={payload.calculationTrace} />
            ) : (
              // A stored trace whose shape drifted or was corrupted still shows
              // its raw JSON instead of crashing the whole detail page (#1050).
              <details className="alertExtracted">
                <summary>Traza de cálculo (formato no reconocido)</summary>
                <pre>{JSON.stringify(payload.calculationTrace, null, 2)}</pre>
              </details>
            )
          ) : (
            <p className="alertMeta">
              Sin traza de cálculo
              {payload.calculationTraceUnavailable
                ? `: ${payload.calculationTraceUnavailable}`
                : "."}
            </p>
          )}
          {payload.extractedData !== undefined ? (
            <details className="alertExtracted">
              <summary>Datos extraídos del documento</summary>
              <pre>{JSON.stringify(payload.extractedData, null, 2)}</pre>
            </details>
          ) : null}
          {payload.conversationRef ? (
            <p className="alertMeta">Conversación: {payload.conversationRef}</p>
          ) : null}
        </>
      )}
    </article>
  );
}

/** Narrow an occurrence's opaque JSON to the payload shape, defensively. */
function asPayload(value: unknown): MaintainerAlertPayload | null {
  if (value === null || typeof value !== "object") return null;
  return value as MaintainerAlertPayload;
}

export function MaintainerAlertDetail({
  alert,
}: {
  alert: MaintainerAlertWithOccurrences;
}) {
  const isOpen = alert.status === "open";
  return (
    <main className="demoLanding maintainerAlerts">
      <header className="demoLandingHead">
        <p className="demoKicker">worthline · admin · alertas</p>
        <h1>{maintainerAlertCategoryLabel(alert.category)}</h1>
        <p className="demoLede">
          {statusLabel(alert.status)} · {alert.occurrenceCount} ocurrencia(s) · workspace{" "}
          {alert.workspaceId} · holding {alert.holdingId}
        </p>
        <p className="alertMeta">
          <a href="/admin/alertas">← Todas las alertas</a>
          {alert.supersedesAlertId ? (
            <>
              {" · "}
              <a href={`/admin/alertas/${alert.supersedesAlertId}`}>
                Regresión de una alerta anterior
              </a>
            </>
          ) : null}
        </p>
      </header>

      {!isOpen ? (
        <section className="section">
          <p className="alertMeta">
            Cerrada como <strong>{statusLabel(alert.status)}</strong>
            {alert.resolutionNote ? ` — ${alert.resolutionNote}` : ""}
            {alert.resolutionLink ? (
              <>
                {" · "}
                <a href={alert.resolutionLink}>{alert.resolutionLink}</a>
              </>
            ) : null}
          </p>
        </section>
      ) : null}

      <section className="section">
        {alert.occurrences.map((occurrence, index) => (
          <OccurrenceView
            key={occurrence.id}
            index={index}
            occurredAt={occurrence.occurredAt}
            payload={asPayload(occurrence.payload)}
          />
        ))}
      </section>

      {isOpen ? (
        <section className="section alertResolve">
          <h2>Cerrar alerta</h2>
          <form action={resolveMaintainerAlertAction}>
            <input name="alertId" type="hidden" value={alert.id} />
            <label>
              Nota (opcional)
              <input name="note" type="text" />
            </label>
            <label>
              Enlace (opcional)
              <input name="link" type="url" />
            </label>
            <div className="rowActions">
              <button className="btnSmall" name="status" type="submit" value="resolved">
                Resolver
              </button>
              <button
                className="btnSmall btnWarning"
                name="status"
                type="submit"
                value="dismissed"
              >
                Descartar
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </main>
  );
}
