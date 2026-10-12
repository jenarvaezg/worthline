"use client";

/**
 * What a form re-opened by «Añadir otra» starts with (#1829).
 *
 * After registering from the ficha's side panel, the success notice offers to open
 * the same form again with the date and the currency of the one just sent — the two
 * things a run of buys typed off one statement shares. The form is server-rendered
 * with its own defaults (today, the ledger's last currency), so the remembered
 * values reach it through this context instead: the ficha provides them around the
 * panel it re-opens, and a form reads them as defaults that beat its own.
 *
 * Outside a provider the seed is empty, so a form placed anywhere else is unchanged.
 */

import { type ComponentProps, createContext, type ReactNode, useContext } from "react";

/** The remembered defaults: field values by name, and which of a form's variants was used. */
export interface FormSeed {
  /** Which variant of the action's form was sent (Cobros: `suelto` or `recurrente`). */
  choice?: string;
  values: Readonly<Record<string, string>>;
}

const EMPTY_SEED: FormSeed = { values: {} };

const FormSeedContext = createContext<FormSeed>(EMPTY_SEED);

export function FormSeedProvider({
  children,
  seed,
}: {
  children: ReactNode;
  /** Null when the form opens on its own defaults. */
  seed: FormSeed | null;
}) {
  return (
    <FormSeedContext.Provider value={seed ?? EMPTY_SEED}>
      {children}
    </FormSeedContext.Provider>
  );
}

/** The seed of the form being opened — empty unless «Añadir otra» opened it. */
export function useFormSeed(): FormSeed {
  return useContext(FormSeedContext);
}

/**
 * The attribute that names which variant of a form a pane holds, so the ficha can
 * tell, as a form leaves, which of them was sent (`closest(...)` from the form).
 */
export const SEED_CHOICE_ATTRIBUTE = "data-seed-choice";

/**
 * One option of a choice between a form's variants (a `.segmented` radio). It
 * starts checked when the seed chose it, or — with no seed — when it is
 * `defaultChoice`. Uncontrolled: the choice itself shows its pane through CSS, so
 * it works before (and without) JavaScript.
 */
export function SeededChoice({
  children,
  defaultChoice,
  name,
  value,
}: {
  children: ReactNode;
  defaultChoice: string;
  name: string;
  value: string;
}) {
  const { choice } = useFormSeed();
  return (
    <label>
      <input
        defaultChecked={(choice ?? defaultChoice) === value}
        name={name}
        type="radio"
        value={value}
      />
      {children}
    </label>
  );
}

/**
 * An uncontrolled input whose default is the seed's value for its `name`, or
 * `fallback` — the piece a server-rendered form drops in where a remembered value
 * should land (the one-off cobro's date).
 */
export function SeededInput({
  fallback,
  name,
  ...props
}: Omit<ComponentProps<"input">, "defaultValue" | "name"> & {
  name: string;
  fallback: string;
}) {
  const { values } = useFormSeed();
  return <input {...props} defaultValue={values[name] ?? fallback} name={name} />;
}
