import { localRedirectPath, parseScopeCookie, SCOPE_COOKIE_NAME } from "@web/intake";
import { cookies } from "next/headers";
import { RETURN_AFTER_REMOVE_FIELD } from "./connected-source-form-ids";

export const BASE = "/ajustes";
export const CONNECTED_SOURCE_PERSISTENCE_ERROR_MESSAGE =
  "No se pudo guardar la sincronización. Revisa el almacenamiento y vuelve a intentarlo.";

export function connectedSourceProviderErrorMessage(providerLabel: string): string {
  return `No se pudo sincronizar con ${providerLabel}. Revisa la clave de API y la conexión.`;
}

/**
 * El aviso de unas credenciales nuevas que el proveedor rechaza (#1225, PRD
 * #1222). Dice lo único que el usuario necesita saber para no entrar en pánico:
 * que NO se ha pisado nada y la conexión sigue viva con las de antes.
 *
 * Leaf helper compartido por los dos adapters (ADR 0043 §2): el texto es
 * idéntico salvo el nombre del proveedor, y la promesa que hace —«las anteriores
 * siguen guardadas»— es exactamente el invariante que ambas acciones cumplen al
 * validar antes de escribir.
 */
export function connectedSourceCredentialsRejectedMessage(providerLabel: string): string {
  return `${providerLabel} rechazó esas credenciales, así que no se ha guardado nada: las anteriores siguen intactas. Revísalas y vuelve a intentarlo.`;
}

export function currentUrlOf(formData: FormData): string {
  return localRedirectPath(String(formData.get("currentUrl") ?? ""), BASE);
}

/**
 * Adónde aterriza una desconexión que salió bien (#1849). «Convertir en activo
 * manual» vuelve a la página desde la que se envió: el activo sigue ahí, ya de
 * valor guardado. «Eliminar y conservar histórico» también, salvo que el formulario
 * diga otro destino ({@link RETURN_AFTER_REMOVE_FIELD}): desde la ficha del activo,
 * que ese modo borra, volver a ella era un 404. Solo se sigue una ruta de la app.
 */
export function disconnectLanding(formData: FormData, removed: boolean): string {
  const current = currentUrlOf(formData);
  return removed
    ? localRedirectPath(String(formData.get(RETURN_AFTER_REMOVE_FIELD) ?? ""), current)
    : current;
}

export async function scopeMemberId(): Promise<string | undefined> {
  const jar = await cookies();
  return parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
}
