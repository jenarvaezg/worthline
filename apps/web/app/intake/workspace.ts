import { parseMoneyMinor } from "@web/intake-primitives";
import type { Member } from "@worthline/domain";
import { createStableId, type StrictParseResult } from "./shared";

/**
 * Workspace / misc intake parsers (#241 stage 2). Turns the workspace-init,
 * new-member, «empezar» onboarding, and value-update-pass forms into validated
 * command objects. Pure and framework-agnostic.
 */

export interface WorkspaceInitCommand {
  mode: "individual" | "household";
  members: Member[];
}

export function parseWorkspaceInit(formData: FormData): WorkspaceInitCommand {
  const mode = formData.get("mode") === "household" ? "household" : "individual";
  const names = parseNames(formData.get("memberNames"));
  const selectedNames = mode === "individual" ? [names[0] ?? "Yo"] : names;

  return {
    members: selectedNames.map((name, index) => ({
      id: createStableId("member", name, index),
      name,
    })),
    mode,
  };
}

export function parseNewMember(formData: FormData, seed: number): Member | null {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return null;
  }

  return { id: createStableId("member", name, seed), name };
}

/**
 * Parse the «Empezar solo» form (individual path).
 * Expects a single `name` field. Rejects blank names so the error is visible
 * and the typed value can be preserved via the intake v2 redirect pattern.
 */
export function parseEmpezarSolo(
  formData: FormData,
): StrictParseResult<WorkspaceInitCommand> {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { ok: false, error: "El nombre es obligatorio." };
  }

  return {
    ok: true,
    command: {
      mode: "individual",
      members: [{ id: createStableId("member", name, 0), name }],
    },
  };
}

/**
 * Parse the «Crear hogar» form (household path).
 * Expects a `memberNames` textarea with one name per line. Blank lines are
 * filtered silently. Rejects if no non-blank names remain.
 */
export function parseEmpezarHogar(
  formData: FormData,
): StrictParseResult<WorkspaceInitCommand> {
  const names = String(formData.get("memberNames") ?? "")
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);

  if (names.length === 0) {
    return { ok: false, error: "Añade al menos un nombre." };
  }

  return {
    ok: true,
    command: {
      mode: "household",
      members: names.map((name, index) => ({
        id: createStableId("member", name, index),
        name,
      })),
    },
  };
}

/** One row in a value-update-pass: either a diff to apply or a parse error. */
export type ValueUpdateCommand =
  | { id: string; newValueMinor: number }
  | { id: string; error: string };

/**
 * Value-update-pass parser: reads a prefilled "puesta al día" form where each
 * row is named `val_<id>`, diffs against the current values, and returns batch
 * update commands only for changed rows. Invalid values produce per-row errors.
 * Investment assets (derived values) should not appear in the form.
 */
export function parseValueUpdatePass(
  formData: FormData,
  currentAssets: Array<{ id: string; currentValueMinor: number }>,
): ValueUpdateCommand[] {
  const commands: ValueUpdateCommand[] = [];

  for (const asset of currentAssets) {
    const raw = formData.get(`val_${asset.id}`);

    if (raw === null) {
      continue;
    }

    const newValueMinor = parseMoneyMinor(String(raw));

    if (newValueMinor === null) {
      commands.push({ id: asset.id, error: `Valor inválido para ${asset.id}.` });
      continue;
    }

    if (newValueMinor !== asset.currentValueMinor) {
      commands.push({ id: asset.id, newValueMinor });
    }
  }

  return commands;
}

function parseNames(value: FormDataEntryValue | null): string[] {
  const names = String(value ?? "")
    .split(/[\n,]/)
    .map((name) => name.trim())
    .filter(Boolean);

  return names.length > 0 ? names : ["Yo"];
}
