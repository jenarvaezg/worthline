import { PendingSubmit } from "@web/pending-submit";
import type {
  ContributionAllowance,
  ContributionAllowanceUsage,
  ManualAsset,
} from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";

import {
  createContributionAllowanceAction,
  deleteContributionAllowanceAction,
  updateContributionAllowanceAction,
} from "./contribution-allowance-actions";
import {
  type ContributionAllowanceTone,
  contributionAllowanceRowView,
} from "./contribution-allowance-view";

/**
 * Cupo anual de aportación (#1427) — «llevo 1.300 € de los 1.500 posibles».
 *
 * Server-rendered end to end: the figures come from the domain, the editor is a
 * plain form + Server Action (`interaction-patterns.md`, ADR 0036), and each
 * counter can be unfolded into the exact operations it added up (ADR 0077) — a
 * ceiling counter nobody can audit is a ceiling counter nobody should trust.
 */

const BAR_TONE_CLASS: Record<ContributionAllowanceTone, string | undefined> = {
  exceeded: "over",
  ok: undefined,
};

const dayFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

export function ContributionAllowancePanel({
  allowances,
  currency,
  currentUrl,
  destinationOptions,
  formError,
  holdingNameById,
  privacyMode,
  scopeId,
  usageById,
}: {
  allowances: ContributionAllowance[];
  currency: string;
  currentUrl: string;
  /** Holdings a cupo may point at — those with an operation ledger. */
  destinationOptions: ManualAsset[];
  /** Which form bounced, with its message and what was typed into it. */
  formError: {
    formId: string | null;
    message: string;
    values: Record<string, string>;
  } | null;
  holdingNameById: ReadonlyMap<string, string>;
  privacyMode: boolean;
  scopeId: string;
  usageById: ReadonlyMap<string, ContributionAllowanceUsage>;
}) {
  const fmt = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);

  const rows = allowances.flatMap((allowance) => {
    const usage = usageById.get(allowance.id);
    return usage
      ? [contributionAllowanceRowView({ allowance, holdingNameById, usage })]
      : [];
  });

  const errorFor = (formId: string) =>
    formError?.formId === formId ? formError.message : null;
  const createValues = formError?.formId === "allowance" ? formError.values : {};
  const preservedIds = createValues.holdingIds
    ? createValues.holdingIds.split(",").filter(Boolean)
    : null;

  return (
    <section
      className="firePanel objetivosCupoPanel"
      aria-label="Cupo anual de aportación"
    >
      <div className="panelHeader">
        <h3>Cupo anual de aportación</h3>
        <span>cuánto llevas aportado este año y cuánto te queda</span>
      </div>

      {rows.length === 0 ? (
        <p className="objetivosCupoEmpty">
          Aún no has definido ningún cupo. Un cupo es un tope de aportación por año
          natural — el de tus planes de pensiones, por ejemplo — y worthline cuenta contra
          él lo que de verdad has aportado.
        </p>
      ) : null}

      {rows.map((row) => {
        const { allowance } = row;

        return (
          <article
            className="objetivosCupoRow"
            id={`allowanceEdit-${allowance.id}`}
            key={allowance.id}
          >
            <div className="objetivosCupoTop">
              <span className="objetivosCupoName">{row.label}</span>
              <span className="objetivosCupoYear">año {row.year}</span>
            </div>

            <p className="objetivosCupoFigure">
              <strong>{fmt(row.consumedMinor)}</strong> de {fmt(row.capMinor)} ·{" "}
              <span className={`objetivosCupoRemainder ${row.tone}`}>
                {row.remainderWord === "quedan"
                  ? `quedan ${fmt(row.remainderAmountMinor)}`
                  : `te has pasado ${fmt(row.remainderAmountMinor)}`}
              </span>
            </p>

            <div
              aria-label={`${row.label}: ${fmt(row.consumedMinor)} de ${fmt(row.capMinor)}`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(row.barPercent)}
              className="fundedBar"
              role="meter"
            >
              <i
                className={BAR_TONE_CLASS[row.tone]}
                style={{ width: `${row.barPercent}%` }}
              />
            </div>

            <p className="objetivosCupoNote">
              Consume{row.destinationNames.length === 1 ? "" : "n"} este cupo:{" "}
              {row.destinationNames.length > 0
                ? row.destinationNames.join(", ")
                : "ningún activo visible"}
              . Cuenta las compras reales del año natural, no lo que el plan preveía.
              {row.unknownDestinationCount > 0
                ? ` ${row.unknownDestinationCount} destino${row.unknownDestinationCount === 1 ? "" : "s"} marcado${row.unknownDestinationCount === 1 ? "" : "s"} no está${row.unknownDestinationCount === 1 ? "" : "n"} en esta pantalla: sus aportaciones no se han contado.`
                : ""}
              {row.skippedForeignCount > 0
                ? ` ${row.skippedForeignCount} operación${row.skippedForeignCount === 1 ? "" : "es"} en otra divisa se ha${row.skippedForeignCount === 1 ? "" : "n"} dejado fuera.`
                : ""}
            </p>

            <details suppressHydrationWarning className="objetivosCupoAudit">
              <summary>
                {row.entries.length === 1
                  ? "Ver la aportación contada"
                  : `Ver las ${row.entries.length} aportaciones contadas`}
              </summary>
              {row.entries.length === 0 ? (
                <p className="muted">Ninguna aportación registrada este año.</p>
              ) : (
                <ul className="objetivosCupoEntries">
                  {row.entries.map((entry) => (
                    <li key={entry.operationId}>
                      <span>
                        {dayFormatter.format(new Date(`${entry.dateISO}T00:00:00Z`))}
                      </span>
                      <span>
                        {holdingNameById.get(entry.holdingId) ?? entry.holdingId}
                      </span>
                      <span className="objetivosCupoEntryAmount">
                        {fmt(entry.amountMinor)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </details>

            <details suppressHydrationWarning className="objetivosCupoEditor">
              <summary>Editar cupo</summary>
              <form action={updateContributionAllowanceAction} className="stackForm">
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <input name="allowanceId" type="hidden" value={allowance.id} />
                {errorFor(`allowance-${allowance.id}`) ? (
                  <p className="formError" role="alert">
                    {errorFor(`allowance-${allowance.id}`)}
                  </p>
                ) : null}
                <label>
                  Nombre
                  <input defaultValue={allowance.label} name="label" />
                </label>
                <label>
                  Tope anual de aportación ({currency})
                  <input
                    defaultValue={(allowance.annualCapMinor / 100).toString()}
                    inputMode="decimal"
                    name="annualCap"
                  />
                </label>
                <span className="memberProfileLabel">Activos que consumen el cupo</span>
                <span className="chipChoice">
                  {destinationOptions.map((asset) => (
                    <label key={asset.id}>
                      <input
                        defaultChecked={allowance.holdingIds.includes(asset.id)}
                        name="holdingIds"
                        type="checkbox"
                        value={asset.id}
                      />
                      {asset.name}
                    </label>
                  ))}
                </span>
                <PendingSubmit pendingLabel="Guardando…">Guardar cupo</PendingSubmit>
              </form>
              <form action={deleteContributionAllowanceAction}>
                <input name="currentUrl" type="hidden" value={currentUrl} />
                <input name="allowanceId" type="hidden" value={allowance.id} />
                <details suppressHydrationWarning className="confirmDelete">
                  <summary>Eliminar</summary>
                  <PendingSubmit pendingLabel="Borrando…">
                    Confirmar borrado
                  </PendingSubmit>
                </details>
              </form>
            </details>
          </article>
        );
      })}

      <div className="createBlock">
        <div className="memberProfileLabel">Nuevo cupo</div>
        {destinationOptions.length === 0 ? (
          <p className="muted">
            Un cupo cuenta compras reales, así que necesita al menos una inversión con
            libro de operaciones. Da de alta el plan de pensiones (o el fondo) y sus
            aportaciones antes de fijarle un tope.
          </p>
        ) : (
          <form
            action={createContributionAllowanceAction}
            className="stackForm"
            id="allowanceCreateForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="scopeId" type="hidden" value={scopeId} />
            {errorFor("allowance") ? (
              <p className="formError" role="alert">
                {errorFor("allowance")}
              </p>
            ) : null}
            <label>
              Nombre
              <input
                defaultValue={createValues.label}
                name="label"
                placeholder="Planes de pensiones"
              />
            </label>
            <label>
              Tope anual de aportación ({currency})
              <input
                defaultValue={createValues.annualCap}
                inputMode="decimal"
                name="annualCap"
                placeholder="1500"
              />
            </label>
            <span className="memberProfileLabel">Activos que consumen el cupo</span>
            <span className="chipChoice">
              {destinationOptions.map((asset) => (
                <label key={asset.id}>
                  <input
                    defaultChecked={
                      preservedIds ? preservedIds.includes(asset.id) : false
                    }
                    name="holdingIds"
                    type="checkbox"
                    value={asset.id}
                  />
                  {asset.name}
                </label>
              ))}
            </span>
            <p className="objetivosCupoHint">
              El tope lo pones tú: worthline no calcula límites fiscales — dependen de la
              normativa del ejercicio, de las aportaciones de empresa y de tus
              rendimientos del trabajo. Consúltalo en la fuente oficial y anótalo aquí.
            </p>
            <PendingSubmit className="createGoalSubmit" pendingLabel="Creando…">
              Crear cupo
            </PendingSubmit>
          </form>
        )}
      </div>
    </section>
  );
}
