"use server";

import { withStore } from "@worthline/db";
import { redirect } from "next/navigation";

import {
  appendParam,
  errorRedirectUrl,
  parseEntityId,
  parseFireConfigFormStrict,
  parseNewMember,
} from "../intake";

const BASE = "/ajustes";

function currentUrlOf(formData: FormData): string {
  return (formData.get("currentUrl") as string) || BASE;
}

// === Member actions ===

export async function createMemberAction(formData: FormData) {
  const member = parseNewMember(formData, Date.now());

  if (!member) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "El nombre del miembro es obligatorio.",
        formId: "newMember",
      }),
    );
  }

  withStore((store) => store.createMember(member));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function updateMemberAction(formData: FormData) {
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

  withStore((store) => store.updateMember({ id, name }));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function disableMemberAction(formData: FormData) {
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de miembro no encontrado.",
      }),
    );
  }

  withStore((store) => store.disableMember(id, new Date().toISOString()));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function reactivateMemberAction(formData: FormData) {
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de miembro no encontrado.",
      }),
    );
  }

  withStore((store) => store.reactivateMember(id));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

// === FIRE config action ===

export async function saveFireConfigAction(formData: FormData) {
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

  withStore((store) => store.saveFireConfig(scopeId, result.command));
  redirect(appendParam(currentUrlOf(formData), "ok", "fire_saved"));
}

// === Warning override retract action ===

export async function retractWarningOverrideAction(formData: FormData) {
  const code = String(formData.get("code") ?? "").trim();
  const entityId = String(formData.get("entityId") ?? "").trim();

  if (!code || !entityId) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Datos de aviso no válidos.",
      }),
    );
  }

  withStore((store) => store.removeWarningOverride(code, entityId));
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}
