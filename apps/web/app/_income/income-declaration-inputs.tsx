/**
 * The declaration proper of an income (#1673): nature, amount basis, provenance +
 * cut-off, condition. Rendered identically on the door (declaring an income, on the
 * Rentas surface or a holding's ficha) and on a row's correction form, because the
 * two post the same field names to the same parser.
 *
 * Every choice is a visible three-state `.segmented` control, never a select with a
 * value nobody picked (#1673 «cuidado con»): «Sin declarar» is an option you can
 * SEE, it opens checked, and the sentence beside it says what it means — that the
 * income then counts in no figure. A checkbox would degrade to `false` in a partial
 * form; three radios cannot. The provenance has no «sin declarar»: nothing is
 * preselected and the door refuses to open without it, saying why.
 *
 * No `required` attribute anywhere: the parser refuses with a sentence, the same on
 * every door, and a native bubble on a field folded out of sight would block the
 * submit without telling anyone why.
 */

import type { ReactNode } from "react";
import {
  INCOME_AMOUNT_BASIS_CHOICES,
  INCOME_NATURE_CHOICES,
  INCOME_PROVENANCE_CHOICES,
  type IncomeDeclarationFields,
} from "./income-form";

function ChoiceFieldset({
  choices,
  legend,
  name,
  note,
  required = false,
  selected,
}: {
  choices: ReadonlyArray<{ value: string; label: string }>;
  legend: string;
  name: keyof IncomeDeclarationFields;
  note: ReactNode;
  required?: boolean;
  selected: string;
}) {
  return (
    // A radio group by role, so `aria-required` is announced where it applies.
    <fieldset aria-required={required} className="incomeChoice" role="radiogroup">
      <legend>{legend}</legend>
      <span className="segmented">
        {choices.map((choice) => (
          <label key={choice.value || "undeclared"}>
            <input
              defaultChecked={selected === choice.value}
              name={name}
              type="radio"
              value={choice.value}
            />
            {choice.label}
          </label>
        ))}
      </span>
      <p className="incomeChoiceNote">{note}</p>
    </fieldset>
  );
}

export function IncomeDeclarationInputs({
  values,
}: {
  /** What to prefill: an existing declaration, or the fields a refused post typed. */
  values: Readonly<Partial<Record<keyof IncomeDeclarationFields, string>>>;
}) {
  return (
    <>
      <ChoiceFieldset
        choices={INCOME_NATURE_CHOICES}
        legend="Naturaleza"
        name="nature"
        note={
          <>
            Solo una renta <strong>pasiva</strong> entra en tu renta pasiva y en tu FIRE.
            Del trabajo no cuenta como renta pasiva, y <strong>sin declarar</strong> no
            cuenta en ninguna cifra.
          </>
        }
        selected={values.nature ?? ""}
      />
      <ChoiceFieldset
        choices={INCOME_AMOUNT_BASIS_CHOICES}
        legend="El importe está en"
        name="amountBasis"
        note={
          <>
            Tus cifras razonan en euros de hoy, así que solo cuenta un importe en{" "}
            <strong>euros de hoy</strong>. En euros de cada cobro (nominal) o{" "}
            <strong>sin declarar</strong>, no cuenta en ninguna cifra.
          </>
        }
        selected={values.amountBasis ?? ""}
      />
      <ChoiceFieldset
        choices={INCOME_PROVENANCE_CHOICES}
        legend="De dónde sale la cifra"
        name="provenance"
        note="Obligatorio. Una cifra copiada de una simulación caduca: hay que saber de dónde salió."
        required
        selected={values.provenance ?? ""}
      />
      <div className="cobrosFormGrid">
        <label>
          Fecha de corte de la cifra
          <input
            defaultValue={values.provenanceAsOf ?? ""}
            name="provenanceAsOf"
            type="date"
          />
        </label>
        <label>
          Supone seguir cotizando hasta (opcional)
          <input
            defaultValue={values.assumedContributionThrough ?? ""}
            name="assumedContributionThrough"
            type="date"
          />
        </label>
      </div>
      <p className="incomeChoiceNote">
        La fecha de corte es el día al que corresponden los datos —la fecha de la
        simulación, por ejemplo—, no el día en que la apuntas. La condición, si la hay, es
        hasta cuándo supone la cifra que sigues cotizando.
      </p>
    </>
  );
}
