"use server";

import { isWriteBlocked } from "@web/demo/write-guard";

/**
 * PROTOTIPO #1737 — desechable. Acciones que no escriben nada: el prototipo pinta
 * los formularios reales con estas en lugar de las suyas, porque el entorno de
 * desarrollo apunta a datos de verdad. Además, la isla del prototipo corta todo
 * envío antes de que llegue a cualquier acción (ver `ficha-prototype.tsx`).
 *
 * Pasan por el guard de escritura igual que cualquier acción (#1180), aunque no
 * escriban: así el guardián no necesita una excepción para el prototipo.
 */

export async function prototypeNoopAction(_formData: FormData): Promise<void> {
  if (await isWriteBlocked()) return;
}

export async function prototypeNoopPreview<State>(
  prev: State,
  _formData: FormData,
): Promise<State> {
  await isWriteBlocked();
  return prev;
}
