/**
 * The chrome every alta pane shares (#1700): its heading, a labelled field, a
 * radio choice, and the submit/cancel pair that closes it.
 *
 * Presentation only — no family knowledge, no reads. It sits beside the family
 * modules rather than in the page because the page no longer defines panes; it
 * places them (ADR 0095's rule, applied to the alta).
 */

import { PendingSubmit } from "@web/pending-submit";
import Link from "next/link";
import type { ReactNode } from "react";

/** What a rejected alta brought back, keyed by the field its pane posts. */
export type PaneValues = Record<string, string>;

/** One round-tripped value, or undefined when the field was never filled. */
export function paneValue(values: PaneValues, key: string): string | undefined {
  return values[key];
}

export function PaneActions() {
  return (
    <div className="formActions simplePaneActions">
      <PendingSubmit pendingLabel="Añadiendo…">Añadir</PendingSubmit>
      <Link href="/patrimonio">Cancelar</Link>
    </div>
  );
}

export function PaneHeader({ text, title }: { text: string; title: string }) {
  return (
    <div className="simplePaneIntro">
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

export function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="simpleField">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function RadioChoice({
  checked,
  label,
  name,
  value,
}: {
  checked: boolean;
  label: string;
  name: string;
  value: string;
}) {
  return (
    <label className="ownerPreset simpleChoice">
      <input defaultChecked={checked} name={name} type="radio" value={value} />
      {label}
    </label>
  );
}
