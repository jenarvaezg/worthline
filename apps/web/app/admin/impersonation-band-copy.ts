/**
 * What the impersonation band says, given the screen it is standing on (#1732).
 *
 * The band is mounted from the root layout, so it follows the admin everywhere —
 * including back into `/admin`, which is NOT the impersonated workspace but the
 * admin's own console. There it kept claiming «Viendo como ana@…», so the one
 * screen that shows every workspace read as if it were one of them.
 *
 * Hiding it there was the wrong fix twice over: the impersonation cookie is still
 * set (the next click on any product route lands back in Ana's book), and «Salir»
 * is the control that clears it. So the band stays and tells the truth instead —
 * the session is what it announces, and the console says it is the console.
 */

/** The admin console's own routes — everything under `/admin`. */
export function isAdminConsolePath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

export interface ImpersonationBandCopy {
  /** The band's sentence, with `email` already placed. */
  lead: string;
  /** The word the band is labelled by, for assistive tech. */
  ariaLabel: string;
}

export function impersonationBandCopy(
  pathname: string,
  email: string,
): ImpersonationBandCopy {
  return isAdminConsolePath(pathname)
    ? {
        ariaLabel: "Impersonación de administrador",
        lead: `Impersonación abierta sobre ${email}. Esta pantalla es tu consola de administración, no su espacio: lo que ves aquí es tuyo.`,
      }
    : {
        ariaLabel: "Impersonación de administrador",
        lead: `Viendo como ${email} (solo lectura)`,
      };
}
