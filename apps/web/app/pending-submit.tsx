"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * A submit button that reflects its form's in-flight state (PRD #160).
 *
 * Server-action form POSTs give NO native feedback while the action runs, so a
 * slow Numista sync (pull 20+ coins → value each → ripple history) looked frozen:
 * the button just sat there until the page reloaded. This is the ADR 0009 escape
 * hatch — a minimal client island (cf. ImportWorkspaceForm, the composition-chart
 * tooltip) — that swaps the label to `pendingLabel` and disables the button while
 * the parent `<form action={…}>` is pending, via React's `useFormStatus`.
 */
export function PendingSubmit({
  children,
  pendingLabel,
  className,
}: {
  children: ReactNode;
  /**
   * Label shown while the form action is in flight, e.g. "Sincronizando…".
   * Omit to keep `children` unchanged (e.g. scope tabs, #607 — they just disable
   * + go aria-busy, the label stays the tab name).
   */
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button aria-busy={pending} className={className} disabled={pending} type="submit">
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}
