import { cookies } from "next/headers";

import { localRedirectPath, parseScopeCookie, SCOPE_COOKIE_NAME } from "@web/intake";

export const BASE = "/ajustes";
export const CONNECTED_SOURCE_PERSISTENCE_ERROR_MESSAGE =
  "No se pudo guardar la sincronización. Revisa el almacenamiento y vuelve a intentarlo.";

export function connectedSourceProviderErrorMessage(providerLabel: string): string {
  return `No se pudo sincronizar con ${providerLabel}. Revisa la clave de API y la conexión.`;
}

export function currentUrlOf(formData: FormData): string {
  return localRedirectPath(String(formData.get("currentUrl") ?? ""), BASE);
}

export async function scopeMemberId(): Promise<string | undefined> {
  const jar = await cookies();
  return parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
}
