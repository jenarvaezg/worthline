"use server";

import { actionScopeExists, INVALID_SCOPE_MESSAGE } from "@web/action-scope";
import {
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";

import {
  appendParam,
  errorRedirectUrl,
  parseEntityId,
  parseFireConfigFormStrict,
  parseNewMember,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import {
  type Clock,
  parseWorkspaceExport,
  type RiskTolerance,
  summarizeWorkspaceExport,
  systemClock,
  type WorkspaceExportSummary,
} from "@worthline/domain";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { currentUrlOf } from "./connected-source-helpers";

// === Member actions ===

function isClock(value: unknown): value is Clock {
  return (
    typeof value === "object" && value !== null && "now" in value && "today" in value
  );
}

export async function createMemberAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const member = parseNewMember(formData, Date.now());

  if (!member) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "El nombre del miembro es obligatorio.",
        formId: "newMember",
      }),
    );
  }

  await runActionWithStore((store) => store.workspace.createMember(member), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function updateMemberAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const id = parseEntityId(formData);
  const name = String(formData.get("name") ?? "").trim();

  if (!id || !name) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: !id
          ? "Identificador de miembro no encontrado."
          : "El nombre del miembro es obligatorio.",
      }),
    );
  }

  await runActionWithStore((store) => store.workspace.updateMember({ id, name }), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

/**
 * Save a member's profile (PRD #421, #423): birth year, fiscal country and risk
 * tolerance. Each field is optional — a blank input clears it. Garbage (a
 * non-numeric year, an unknown risk value) is dropped rather than rejected, so a
 * partial edit still saves the valid fields.
 */
export async function updateMemberProfileAction(
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de miembro no encontrado.",
      }),
    );
  }

  const birthYearRaw = String(formData.get("birthYear") ?? "").trim();
  const birthYearParsed = Number.parseInt(birthYearRaw, 10);
  const birthYear =
    birthYearRaw && !Number.isNaN(birthYearParsed) ? birthYearParsed : undefined;

  const fiscalCountry = String(formData.get("fiscalCountry") ?? "").trim() || undefined;

  const riskRaw = String(formData.get("riskTolerance") ?? "").trim();
  const riskTolerance: RiskTolerance | undefined =
    riskRaw === "conservative" || riskRaw === "moderate" || riskRaw === "aggressive"
      ? riskRaw
      : undefined;

  // Conditional spread (exactOptionalPropertyTypes): omit an unset field rather
  // than pass `undefined`. The store clears any omitted field to NULL, so a
  // blank input still erases the previous value.
  await runActionWithStore(
    (store) =>
      store.workspace.updateMemberProfile(id, {
        ...(birthYear !== undefined ? { birthYear } : {}),
        ...(fiscalCountry !== undefined ? { fiscalCountry } : {}),
        ...(riskTolerance !== undefined ? { riskTolerance } : {}),
      }),
    _store,
  );
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function disableMemberAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de miembro no encontrado.",
      }),
    );
  }

  await runActionWithStore(
    (store) => store.workspace.disableMember(id, _clock.now()),
    _store,
  );
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function reactivateMemberAction(
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de miembro no encontrado.",
      }),
    );
  }

  await runActionWithStore((store) => store.workspace.reactivateMember(id), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function hardDeleteMemberAction(
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de miembro no encontrado.",
      }),
    );
  }

  const result = await runActionWithStore(async (store) => {
    const workspace = await store.workspace.readWorkspace();
    const member = workspace?.members.find((m) => m.id === id);

    if (!member) {
      return { ok: false as const, error: "Miembro no encontrado." };
    }

    if (!member.disabledAt) {
      return {
        ok: false as const,
        error: "Solo puedes borrar definitivamente un miembro desactivado.",
      };
    }

    const owned = await store.workspace.readMemberOwnerships(id);
    const holdings = [...owned.assets, ...owned.liabilities];

    if (holdings.length > 0) {
      const names = holdings.map((h) => h.name).join(", ");
      return {
        ok: false as const,
        error: `No se puede borrar a ${member.name}: participa en ${names}. Reasigna o elimina esos elementos primero.`,
      };
    }

    const changes = await store.workspace.hardDeleteMember(id);

    if (changes === 0) {
      return { ok: false as const, error: "No se pudo borrar el miembro." };
    }

    return { ok: true as const };
  }, _store);

  if (!result.ok) {
    redirect(errorRedirectUrl(currentUrlOf(formData), { message: result.error }));
  }

  redirect(appendParam(currentUrlOf(formData), "ok", "member_deleted"));
}

// === Workspace reset action ===

/** The exact phrase the user must type to arm the full workspace reset. */
const RESET_CONFIRMATION_PHRASE = "borrar todo";

export async function resetWorkspaceAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const confirmation = String(formData.get("confirmation") ?? "").trim();

  // The typed phrase is the gate: a wrong or empty phrase aborts harmlessly.
  if (confirmation !== RESET_CONFIRMATION_PHRASE) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: `Escribe «${RESET_CONFIRMATION_PHRASE}» para confirmar el borrado total.`,
      }),
    );
  }

  await runActionWithStore((store) => store.workspace.resetWorkspace(), _store);

  // No workspace left → the app belongs at onboarding.
  redirect("/empezar");
}

// === Workspace import actions ===

/**
 * Serializable result of previewing an import file (#104), shaped for
 * `useActionState`: idle before any submit, a per-section content summary for
 * a valid file, or the validation errors for an invalid one.
 */
export type ImportPreviewState =
  | { status: "idle" }
  | { status: "error"; errors: string[] }
  | { status: "summary"; summary: WorkspaceExportSummary };

/**
 * Preview an import file (#104): read the uploaded JSON, validate it with
 * parseWorkspaceExport, and summarize what it contains. Pure read of the
 * uploaded file — performs NO DB access and writes nothing; the actual
 * replacement only happens later in confirmImportAction, which re-validates.
 */
export async function previewImportAction(
  _prevState: ImportPreviewState,
  formData: FormData,
): Promise<ImportPreviewState> {
  await guardDemoWrite(currentUrlOf(formData));
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return {
      status: "error",
      errors: ["Selecciona un archivo de exportación (.json) para ver su contenido."],
    };
  }

  const text = await file.text();
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return {
      status: "error",
      errors: ["El archivo no contiene JSON válido y no se puede importar."],
    };
  }

  const result = parseWorkspaceExport(raw);

  if (!result.ok) {
    return { status: "error", errors: result.errors };
  }

  return { status: "summary", summary: summarizeWorkspaceExport(result.value) };
}

/**
 * Import a workspace export file (ADR 0010, #103): validate the uploaded JSON
 * with parseWorkspaceExport and, only when fully valid, atomically replace the
 * entire workspace with the file's contents.
 */
export async function confirmImportAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Selecciona un archivo de exportación (.json) para importar.",
        formId: "import",
      }),
    );
  }

  const text = await file.text();
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "El archivo no contiene JSON válido y no se puede importar.",
        formId: "import",
      }),
    );
  }

  const result = parseWorkspaceExport(raw);

  if (!result.ok) {
    const shown = result.errors.slice(0, 3).join(" · ");
    const remaining = result.errors.length - 3;
    const suffix = remaining > 0 ? ` (y ${remaining} errores más)` : "";

    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: `No se pudo importar: ${shown}${suffix}`,
        formId: "import",
      }),
    );
  }

  const importResult = await runActionWithStore(
    (store) => store.workspace.importWorkspace(result.value),
    _store,
  );

  // The previous workspace is gone — point the scope cookie at the imported
  // file's first member so the dashboard never resolves a stale member id.
  const firstMemberId = result.value.members[0]?.id;
  const jar = await cookies();

  if (firstMemberId) {
    jar.set(SCOPE_COOKIE_NAME, firstMemberId, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
  } else {
    jar.delete(SCOPE_COOKIE_NAME);
  }

  // The import committed, but the best-effort historical-snapshot gap-fill
  // failed (#185): it is now surfaced rather than swallowed, so prompt the user
  // to re-run the backfill instead of silently landing on a dashboard with a
  // partial history.
  if (importResult.gapFillError) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message:
          "Se importaron tus datos, pero la reconstrucción del histórico falló. " +
          "Vuelve a ejecutar el relleno del histórico.",
        formId: "import",
      }),
    );
  }

  // A valid import always yields a workspace — land on the dashboard.
  redirect("/");
}

// === FIRE config action ===

export async function saveFireConfigAction(formData: FormData, ..._testArgs: unknown[]) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const scopeId = String(formData.get("scopeId") ?? "").trim() || "household";
  const result = parseFireConfigFormStrict(formData);

  if (!result.ok) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: result.error,
        formId: "fire",
      }),
    );
  }

  const scopeExists = await runActionWithStore(async (store) => {
    return actionScopeExists(store, scopeId);
  }, _store);

  if (!scopeExists) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: INVALID_SCOPE_MESSAGE,
        formId: "fire",
      }),
    );
  }

  await runActionWithStore(
    (store) => store.saveFireConfig(scopeId, result.command),
    _store,
  );
  redirect(appendParam(currentUrlOf(formData), "ok", "fire_saved"));
}

// === Warning override retract action ===

export async function retractWarningOverrideAction(
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const code = String(formData.get("code") ?? "").trim();
  const entityId = String(formData.get("entityId") ?? "").trim();

  if (!code || !entityId) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Datos de aviso no válidos.",
      }),
    );
  }

  await runActionWithStore(
    (store) => store.removeWarningOverride(code, entityId),
    _store,
  );
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}
