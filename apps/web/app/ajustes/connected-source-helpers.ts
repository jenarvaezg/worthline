import { cookies } from "next/headers";

import { parseScopeCookie, SCOPE_COOKIE_NAME } from "@web/intake";

export const BASE = "/ajustes";

export function currentUrlOf(formData: FormData): string {
  return (formData.get("currentUrl") as string) || BASE;
}

export async function scopeMemberId(): Promise<string | undefined> {
  const jar = await cookies();
  return parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);
}
