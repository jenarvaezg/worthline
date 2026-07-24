"use client";

import type { CurrencyCode } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { type FormEvent, useOptimistic, useTransition } from "react";

import { applyValueEdits, parseValueEdits, type ValueEdit } from "./optimistic-values";

/**
 * The "Puesta al día" batch value form as a client island (#521, S5 of #485,
 * ADR 0036, interaction-patterns §4/§7/§8).
 *
 * On submit the just-typed amounts show as each row's new "Actual:" BEFORE
 * `batchValueUpdateAction` resolves — `useOptimistic` folds the parsed edits over
 * the server values with the pure `applyValueEdits`. The action ends in a redirect
 * to /patrimonio, which settles the optimism; on the error redirect the page
 * re-renders this form with the server values + the per-field error band (§4). The
 * form keeps a plain server-action `action=` for no-JS progressive enhancement;
 * `onSubmit` only intercepts when JS is on. Saving is announced through an
 * `aria-live` region (§8). In demo (`readOnly`) the optimism is skipped (§10).
 *
 * The component is a thin shell: the parse + merge live in the pure
 * `optimistic-values` module (the `composition-chart-hover` / `view-state` split).
 */

/** One editable row, already projected by the server page (label, error, value). */
export interface PuestaFieldRow {
  id: string;
  name: string;
  /** Secondary label — the liquidity tier (asset) or "Hipoteca"/"Deuda" (liability). */
  subLabel: string;
  /** The field's `aria-label`, e.g. "Valor de Cuenta ING en EUR". */
  inputLabel: string;
  placeholder: string;
  /** The server value in minor units — the base for the optimistic "Actual:". */
  currentValueMinor: number;
  /** Initial input text: `formatMoneyInput(current)`, or the preserved error value. */
  defaultInput: string;
  fieldError: string | null;
}

function Field({
  row,
  currency,
  privacyMode,
  optimisticValueMinor,
  readOnly,
}: {
  row: PuestaFieldRow;
  currency: CurrencyCode;
  privacyMode: boolean;
  optimisticValueMinor: number;
  readOnly: boolean;
}) {
  return (
    <div className="puestaRow">
      <label htmlFor={`val_${row.id}`}>
        <span className="puestaName">{row.name}</span>
        <small className="puestaTier">{row.subLabel}</small>
      </label>
      <div className="puestaInput">
        <input
          defaultValue={row.defaultInput}
          disabled={readOnly}
          id={`val_${row.id}`}
          inputMode="decimal"
          name={`val_${row.id}`}
          aria-label={row.inputLabel}
          placeholder={row.placeholder}
        />
        <small className="puestaCurrent">
          Actual:{" "}
          {formatMoneyMinorPrivacy(
            { amountMinor: optimisticValueMinor, currency },
            privacyMode,
          )}
        </small>
        {row.fieldError ? (
          <p className="formError" role="alert">
            {row.fieldError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function PuestaAlDiaForm({
  assets,
  liabilities,
  currency,
  privacyMode,
  readOnly = false,
  action,
}: {
  assets: PuestaFieldRow[];
  liabilities: PuestaFieldRow[];
  currency: CurrencyCode;
  privacyMode: boolean;
  readOnly?: boolean;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const rows = [...assets, ...liabilities];
  const ids = rows.map((row) => row.id);
  const base = new Map(rows.map((row) => [row.id, row.currentValueMinor]));

  const [values, addEdits] = useOptimistic(
    base,
    (current: ReadonlyMap<string, number>, edits: readonly ValueEdit[]) =>
      applyValueEdits(current, edits),
  );
  const [isPending, startTransition] = useTransition();

  // Apply the optimistic merge then run the action — both inside the transition so
  // `useOptimistic` tracks it and `isPending` holds until the redirect lands. In demo
  // we let the form fall back to its plain `action=` post (no faked optimism, §10).
  const onSubmit = readOnly
    ? undefined
    : (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const edits = parseValueEdits(formData, ids);
        startTransition(async () => {
          addEdits(edits);
          await action(formData);
        });
      };

  const valueOf = (row: PuestaFieldRow) => values.get(row.id) ?? row.currentValueMinor;

  return (
    <form action={action} className="stackForm" onSubmit={onSubmit}>
      <input name="currentUrl" type="hidden" value="/patrimonio/actualizar" />

      {/* Announce the in-flight save for screen readers (§8); the settled outcome
          rides the page's success/error band after the redirect. */}
      <p aria-live="polite" className="srOnly">
        {isPending ? "Guardando…" : ""}
      </p>

      {assets.length > 0 ? (
        <fieldset className="puestaFieldset">
          <legend>Activos manuales</legend>
          {assets.map((row) => (
            <Field
              currency={currency}
              key={row.id}
              optimisticValueMinor={valueOf(row)}
              privacyMode={privacyMode}
              readOnly={readOnly}
              row={row}
            />
          ))}
        </fieldset>
      ) : null}

      {liabilities.length > 0 ? (
        <fieldset className="puestaFieldset">
          <legend>Deudas</legend>
          {liabilities.map((row) => (
            <Field
              currency={currency}
              key={row.id}
              optimisticValueMinor={valueOf(row)}
              privacyMode={privacyMode}
              readOnly={readOnly}
              row={row}
            />
          ))}
        </fieldset>
      ) : null}

      <div className="puestaFooter">
        <button disabled={readOnly} type="submit">
          Guardar todo
        </button>
        <Link href="/patrimonio">Cancelar</Link>
      </div>
    </form>
  );
}
