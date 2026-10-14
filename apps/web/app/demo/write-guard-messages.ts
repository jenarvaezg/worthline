/** Client-safe copy for demo/impersonation/viewer read-only messaging (see write-guard.ts). */

export const DEMO_DISABLED_MESSAGE =
  "Acción deshabilitada en la demo — datos ficticios de solo lectura.";

export const IMPERSONATION_READONLY_MESSAGE =
  "Impersonación de solo lectura — los datos del usuario no se tocan.";

/** A session viewing a workspace someone shared with it (#1843, ADR 0112). */
export const VIEWER_READONLY_MESSAGE =
  "Acceso de solo lectura: desde aquí no se puede cambiar nada de este espacio.";
