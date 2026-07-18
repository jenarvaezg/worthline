"use server";

import { actionScopeExists, INVALID_SCOPE_MESSAGE } from "@web/action-scope";
import { guardDemoWrite } from "@web/demo/write-guard";
import { formAction } from "@web/form-action";

import {
  appendParam,
  errorRedirectUrl,
  parseFireConfigFormStrict,
  parseNewMember,
  SCOPE_COOKIE_NAME,
} from "@web/intake";
import {
  parseWorkspaceExport,
  type RiskTolerance,
  summarizeWorkspaceExport,
  type WorkspaceExportSummary,
} from "@worthline/domain";
import { cookies } from "next/headers";

import { currentUrlOf } from "./connected-source-helpers";

// === Member actions ===

export const createMemberAction = formAction({
  requireId: false,
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  parse: ({ formData }) => {
    const member = parseNewMember(formData, Date.now());
    if (!member) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          message: "El nombre del miembro es obligatorio.",
          formId: "newMember",
        }),
      };
    }
    return { ok: true, value: member };
  },
  run: async (store, { parsed }) => {
    await store.workspace.createMember(parsed);
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "saved"),
});

export const updateMemberAction = formAction({
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  missingId: "Identificador de miembro no encontrado.",
  missingIdUrl: (fd) => currentUrlOf(fd),
  parse: ({ formData }) => {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          message: "El nombre del miembro es obligatorio.",
        }),
      };
    }
    return { ok: true, value: name };
  },
  run: async (store, { id, parsed }) => {
    await store.workspace.updateMember({ id, name: parsed });
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "saved"),
});

/**
 * Save a member's profile (PRD #421, #423): birth year, fiscal country and risk
 * tolerance. Each field is optional — a blank input clears it. Garbage (a
 * non-numeric year, an unknown risk value) is dropped rather than rejected, so a
 * partial edit still saves the valid fields.
 */
export const updateMemberProfileAction = formAction({
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  missingId: "Identificador de miembro no encontrado.",
  missingIdUrl: (fd) => currentUrlOf(fd),
  run: async (store, { id, formData }) => {
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
    await store.workspace.updateMemberProfile(id, {
      ...(birthYear !== undefined ? { birthYear } : {}),
      ...(fiscalCountry !== undefined ? { fiscalCountry } : {}),
      ...(riskTolerance !== undefined ? { riskTolerance } : {}),
    });
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "saved"),
});

export const disableMemberAction = formAction({
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  missingId: "Identificador de miembro no encontrado.",
  missingIdUrl: (fd) => currentUrlOf(fd),
  run: async (store, { id, now }) => {
    await store.workspace.disableMember(id, now);
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "saved"),
});

export const reactivateMemberAction = formAction({
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  missingId: "Identificador de miembro no encontrado.",
  missingIdUrl: (fd) => currentUrlOf(fd),
  run: async (store, { id }) => {
    await store.workspace.reactivateMember(id);
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "saved"),
});

export const hardDeleteMemberAction = formAction({
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  missingId: "Identificador de miembro no encontrado.",
  missingIdUrl: (fd) => currentUrlOf(fd),
  run: async (store, { id }) => {
    const workspace = await store.workspace.readWorkspace();
    const member = workspace?.members.find((m) => m.id === id);

    if (!member) {
      return { ok: false, error: "Miembro no encontrado." };
    }

    if (!member.disabledAt) {
      return {
        ok: false,
        error: "Solo puedes borrar definitivamente un miembro desactivado.",
      };
    }

    const owned = await store.workspace.readMemberOwnerships(id);
    const holdings = [...owned.assets, ...owned.liabilities];

    if (holdings.length > 0) {
      const names = holdings.map((h) => h.name).join(", ");
      return {
        ok: false,
        error: `No se puede borrar a ${member.name}: participa en ${names}. Reasigna o elimina esos elementos primero.`,
      };
    }

    const changes = await store.workspace.hardDeleteMember(id);

    if (changes === 0) {
      return { ok: false, error: "No se pudo borrar el miembro." };
    }

    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  onSuccess: ({ formData }) =>
    appendParam(currentUrlOf(formData), "ok", "member_deleted"),
});

// === Workspace reset action ===

/** The exact phrase the user must type to arm the full workspace reset. */
const RESET_CONFIRMATION_PHRASE = "borrar todo";

export const resetWorkspaceAction = formAction({
  requireId: false,
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  parse: ({ formData }) => {
    const confirmation = String(formData.get("confirmation") ?? "").trim();
    // The typed phrase is the gate: a wrong or empty phrase aborts harmlessly.
    if (confirmation !== RESET_CONFIRMATION_PHRASE) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          message: `Escribe «${RESET_CONFIRMATION_PHRASE}» para confirmar el borrado total.`,
        }),
      };
    }
    return { ok: true, value: undefined };
  },
  run: async (store) => {
    await store.workspace.resetWorkspace();
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  // No workspace left → the app belongs at onboarding.
  onSuccess: () => "/empezar",
});

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
export const confirmImportAction = formAction({
  requireId: false,
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  run: async (store, { formData }) => {
    const file = formData.get("file");

    if (!(file instanceof File) || file.size === 0) {
      return {
        ok: false,
        error: "Selecciona un archivo de exportación (.json) para importar.",
      };
    }

    const text = await file.text();
    let raw: unknown;

    try {
      raw = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: "El archivo no contiene JSON válido y no se puede importar.",
      };
    }

    const result = parseWorkspaceExport(raw);

    if (!result.ok) {
      const shown = result.errors.slice(0, 3).join(" · ");
      const remaining = result.errors.length - 3;
      const suffix = remaining > 0 ? ` (y ${remaining} errores más)` : "";
      return { ok: false, error: `No se pudo importar: ${shown}${suffix}` };
    }

    const importResult = await store.workspace.importWorkspace(result.value);
    return {
      ok: true,
      value: {
        firstMemberId: result.value.members[0]?.id,
        gapFillError: importResult.gapFillError,
      },
    };
  },
  // The previous workspace is gone — point the scope cookie at the imported
  // file's first member so the dashboard never resolves a stale member id.
  afterCommit: async ({ value }) => {
    const jar = await cookies();
    if (value?.firstMemberId) {
      jar.set(SCOPE_COOKIE_NAME, value.firstMemberId, {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      });
    } else {
      jar.delete(SCOPE_COOKIE_NAME);
    }
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error, formId: "import" }),
  // The import committed, but the best-effort historical-snapshot gap-fill
  // failed (#185): it is now surfaced rather than swallowed, so prompt the user
  // to re-run the backfill instead of silently landing on a dashboard with a
  // partial history.
  onSuccess: ({ formData, value }) =>
    value?.gapFillError
      ? errorRedirectUrl(currentUrlOf(formData), {
          message:
            "Se importaron tus datos, pero la reconstrucción del histórico falló. " +
            "Vuelve a ejecutar el relleno del histórico.",
          formId: "import",
        })
      : "/app",
});

// === FIRE config action ===

export const saveFireConfigAction = formAction({
  requireId: false,
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  parse: ({ formData }) => {
    const scopeId = String(formData.get("scopeId") ?? "").trim() || "household";
    const result = parseFireConfigFormStrict(formData);
    if (!result.ok) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          message: result.error,
          formId: "fire",
        }),
      };
    }
    return { ok: true, value: { scopeId, command: result.command } };
  },
  run: async (store, { parsed }) => {
    if (!(await actionScopeExists(store, parsed.scopeId))) {
      return { ok: false, error: INVALID_SCOPE_MESSAGE };
    }
    await store.saveFireConfig(parsed.scopeId, parsed.command);
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error, formId: "fire" }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "fire_saved"),
});

// === Warning override retract action ===

export const retractWarningOverrideAction = formAction({
  requireId: false,
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  parse: ({ formData }) => {
    const code = String(formData.get("code") ?? "").trim();
    const entityId = String(formData.get("entityId") ?? "").trim();
    if (!code || !entityId) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          message: "Datos de aviso no válidos.",
        }),
      };
    }
    return { ok: true, value: { code, entityId } };
  },
  run: async (store, { parsed }) => {
    await store.removeWarningOverride(parsed.code, parsed.entityId);
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "saved"),
});
