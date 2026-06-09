"use server";

import { withStore, type WorthlineStore } from "@worthline/db";
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

function runWith<T>(fn: (store: WorthlineStore) => T, _store?: WorthlineStore): T {
  return _store ? fn(_store) : withStore(fn);
}

// === Member actions ===

export async function createMemberAction(formData: FormData, _store?: WorthlineStore) {
  const member = parseNewMember(formData, Date.now());

  if (!member) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "El nombre del miembro es obligatorio.",
        formId: "newMember",
      }),
    );
  }

  runWith((store) => store.createMember(member), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function updateMemberAction(formData: FormData, _store?: WorthlineStore) {
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

  runWith((store) => store.updateMember({ id, name }), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function disableMemberAction(formData: FormData, _store?: WorthlineStore) {
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de miembro no encontrado.",
      }),
    );
  }

  runWith((store) => store.disableMember(id, new Date().toISOString()), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

export async function reactivateMemberAction(formData: FormData, _store?: WorthlineStore) {
  const id = parseEntityId(formData);

  if (!id) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Identificador de miembro no encontrado.",
      }),
    );
  }

  runWith((store) => store.reactivateMember(id), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}

// === FIRE config action ===

export async function saveFireConfigAction(formData: FormData, _store?: WorthlineStore) {
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

  runWith((store) => store.saveFireConfig(scopeId, result.command), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "fire_saved"));
}

// === Warning override retract action ===

export async function retractWarningOverrideAction(formData: FormData, _store?: WorthlineStore) {
  const code = String(formData.get("code") ?? "").trim();
  const entityId = String(formData.get("entityId") ?? "").trim();

  if (!code || !entityId) {
    redirect(
      errorRedirectUrl(currentUrlOf(formData), {
        message: "Datos de aviso no válidos.",
      }),
    );
  }

  runWith((store) => store.removeWarningOverride(code, entityId), _store);
  redirect(appendParam(currentUrlOf(formData), "ok", "saved"));
}
