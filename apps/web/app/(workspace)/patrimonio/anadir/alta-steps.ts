/**
 * The alta wizard's step labels (#1732).
 *
 * The simple alta reveals its sections as you fill them (CSS-only disclosure,
 * ADR 0009) and used to say nothing about how many were left. Numbering them is
 * one decision with one trap: the LAST stretch — the reparto — is not always
 * there. `OwnershipInputs` paints no fieldset for a workspace with a single
 * member, so a hardcoded «de 3» would count a step nobody is going to see.
 *
 * So the count is derived from the same fact the form is: how many active members
 * this workspace has. Pure, and tested here rather than grepped out of rendered
 * HTML.
 */

export interface AltaStep {
  /** 1-based position, as printed. */
  index: number;
  /** How many stretches this workspace's alta actually has. */
  total: number;
  /** What the stretch is for, in the user's words. */
  label: string;
}

/** The stretches, in order, for a workspace with `activeMemberCount` members. */
export function altaSteps(activeMemberCount: number): AltaStep[] {
  const labels =
    activeMemberCount > 1
      ? ["Elige el cajón", "Rellena lo justo", "Reparto"]
      : ["Elige el cajón", "Rellena lo justo"];

  return labels.map((label, position) => ({
    index: position + 1,
    label,
    total: labels.length,
  }));
}

/** How a stretch is printed: «Paso 2 de 3 · Rellena lo justo». */
export function altaStepLabel(step: AltaStep): string {
  return `Paso ${step.index} de ${step.total} · ${step.label}`;
}
