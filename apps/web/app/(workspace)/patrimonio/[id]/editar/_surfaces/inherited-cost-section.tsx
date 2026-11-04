"use client";

/**
 * «Coste del traspaso» (#1882, PRD #1876 S7, variant A): the side panel that asks
 * for the cost a traspaso brought into a linked holding without it. The one thing
 * on a holding its source owns that the user writes.
 *
 * Two shapes, decided by the server (`inheritedCostView`):
 * - **with a proposal** — an internal traspaso with a reimbursement in reach: «¿Vienen
 *   del reembolso de…?» with the cost that would travel, «Sí, vienen de ahí» as the
 *   primary, and «No, vienen de otro sitio» as a text control that opens the field.
 *   Nothing is paired until that «Sí».
 * - **without one** — an entry from another institution, or nothing in reach: a
 *   single field, with where to find the figure.
 *
 * A refusal comes back as state beside the field (#1311); success redirects to the
 * ledger with its notice. Not optimistic (interaction-patterns §4): the answer moves
 * a cost basis and re-ripples history, none of it predictable client-side.
 */

import type { FormActionState } from "@web/form-action";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import type { InheritedCostView } from "./inherited-cost-view";

/** The view's money, already formatted by the server (privacy mode included). */
export interface InheritedCostFigures {
  arrived: string;
  proposalAmount: string | null;
  proposalCost: string | null;
}

const WHY = {
  external:
    "Llegaron traspasadas desde otra entidad, y el coste que traían no viaja con el traspaso.",
  internal:
    "Llegaron por un traspaso entre fondos de MyInvestor, que no dice de qué fondo salieron.",
} as const;

function whereToLook(view: InheritedCostView, declined: boolean): string {
  if (view.origin === "external") {
    return "Búscalo en el justificante del traspaso o en el último extracto de la entidad de origen: suele decir «coste» o «aportaciones».";
  }
  const lead = declined
    ? ""
    : "No hay ningún reembolso en los 10 días anteriores que case. ";
  return `${lead}Mira el extracto de MyInvestor de esas fechas: el coste es el de las participaciones que salieron del fondo de origen.`;
}

export default function InheritedCostSection({
  currentUrl,
  figures,
  initialCost = "",
  initialError = null,
  readOnly = false,
  resolveAction,
  view,
}: {
  currentUrl: string;
  figures: InheritedCostFigures;
  /** What a no-JS refusal handed back. */
  initialCost?: string;
  initialError?: string | null;
  /** Demo: the write guard refuses, so the submits are disabled rather than lying (§10). */
  readOnly?: boolean;
  resolveAction: (formData: FormData) => Promise<FormActionState>;
  view: InheritedCostView;
}) {
  const [declined, setDeclined] = useState(false);
  const [cost, setCost] = useState(initialCost);
  const [error, setError] = useState<string | null>(initialError);
  const [pending, startTransition] = useTransition();
  const proposal = declined ? null : view.proposal;
  // «No, vienen de otro sitio» swaps the proposal for the field: focus goes where
  // the person is now asked to type (interaction-patterns §8).
  const costField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (declined) costField.current?.focus();
  }, [declined]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly) return;
    const formData = new FormData(event.currentTarget);
    formData.set("inlineError", "1");
    setError(null);
    startTransition(async () => {
      const result = await resolveAction(formData);
      setError(result.ok ? null : result.error);
      if (!result.ok && result.values?.inheritedCost !== undefined) {
        setCost(result.values.inheritedCost);
      }
    });
  };
  // The SAME server action for the no-JS post: without `inlineError` it redirects on
  // every terminal, so what it resolves to is never read.
  const noJsAction = resolveAction as unknown as (formData: FormData) => Promise<void>;
  const fieldForm = (
    <CostFieldForm
      cost={cost}
      costField={costField}
      currentUrl={currentUrl}
      declined={declined}
      error={error}
      noJsAction={noJsAction}
      onCostChange={setCost}
      onSubmit={onSubmit}
      pending={pending}
      readOnly={readOnly}
      view={view}
    />
  );

  return (
    <section aria-label="Coste del traspaso" className="inheritedCost">
      <h3>Coste del traspaso</h3>
      <p className="inheritedCostContext">
        El <strong>{view.date}</strong> entraron{" "}
        <strong>{view.units} participaciones</strong>, que valían {figures.arrived}.{" "}
        {WHY[view.origin]}
      </p>
      {view.pendingCount > 1 ? (
        <p className="muted">
          Es la primera de {view.pendingCount} entradas sin coste: al guardarla, te
          preguntamos la siguiente.
        </p>
      ) : null}

      {/* The save said out loud (§4): the button that had focus is disabled while
          it runs, so a screen reader would otherwise hear nothing until the end. */}
      <p aria-live="polite" className="srOnly">
        {pending ? "Guardando…" : ""}
      </p>

      {proposal ? (
        <>
          <form
            action={noJsAction}
            aria-label="Confirmar de dónde vienen"
            className="inheritedCostProposal"
            onSubmit={onSubmit}
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="entryId" type="hidden" value={view.entryId} />
            <input name="mode" type="hidden" value="origin" />
            <input name="originId" type="hidden" value={proposal.originId} />
            <p>
              ¿Vienen del <strong>reembolso de {proposal.holdingName}</strong> del{" "}
              {proposal.date} ({figures.proposalAmount})?
            </p>
            <p className="muted">
              Si es así, su coste, <strong>{figures.proposalCost}</strong>, pasa a este
              fondo y ese reembolso deja de contar como una venta.
            </p>
            {error ? (
              <p className="errorBand" role="alert">
                {error}
              </p>
            ) : null}
            <button
              aria-busy={pending || undefined}
              disabled={pending || readOnly}
              type="submit"
            >
              {pending ? "Guardando…" : "Sí, vienen de ahí"}
            </button>
          </form>
          {/* «No, vienen de otro sitio» is a native disclosure, so it opens the
              field before hydration and with JS off: the only working answer must
              never be the «Sí» that pairs the wrong reimbursement. Hydrated, opening
              it swaps the proposal for the field and moves focus there. */}
          <details
            className="inheritedCostElsewhere"
            // A fold the person opened before hydration keeps its `open` (#1270).
            suppressHydrationWarning
            onToggle={(event) => {
              if (event.currentTarget.open && !pending) {
                setDeclined(true);
                setError(null);
              }
            }}
          >
            <summary>No, vienen de otro sitio</summary>
            {fieldForm}
          </details>
        </>
      ) : (
        fieldForm
      )}

      <p className="muted">
        Es lo único de este holding que escribes tú: el resto lo pone MyInvestor, y
        ponerlo al día no lo pisa.
      </p>
    </section>
  );
}

function CostFieldForm({
  cost,
  costField,
  currentUrl,
  declined,
  error,
  noJsAction,
  onCostChange,
  onSubmit,
  pending,
  readOnly,
  view,
}: {
  cost: string;
  costField: RefObject<HTMLInputElement | null>;
  currentUrl: string;
  declined: boolean;
  error: string | null;
  noJsAction: (formData: FormData) => Promise<void>;
  onCostChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  readOnly: boolean;
  view: InheritedCostView;
}) {
  return (
    <form
      action={noJsAction}
      aria-label="Guardar el coste del traspaso"
      className="stackForm inheritedCostForm"
      onSubmit={onSubmit}
    >
      <input name="currentUrl" type="hidden" value={currentUrl} />
      <input name="entryId" type="hidden" value={view.entryId} />
      <input name="mode" type="hidden" value="declared" />
      <label>
        Lo que te costaron esas {view.units} participaciones
        <input
          aria-describedby="inherited-cost-where"
          autoComplete="off"
          className="inheritedCostMoney"
          inputMode="decimal"
          name="inheritedCost"
          onChange={(event) => onCostChange(event.target.value)}
          ref={costField}
          placeholder="0,00 €"
          value={cost}
        />
      </label>
      <p className="muted" id="inherited-cost-where">
        {whereToLook(view, declined)}
      </p>
      {error ? (
        <p className="errorBand" role="alert">
          {error}
        </p>
      ) : null}
      <button
        aria-busy={pending || undefined}
        disabled={pending || readOnly}
        type="submit"
      >
        {pending ? "Guardando…" : "Guardar el coste"}
      </button>
    </form>
  );
}
