/**
 * Where an investment action redirects back to.
 *
 * #153 collapsed the /inversiones management routes; investments now live in
 * the unified Patrimonio list and on each holding's ficha. These fallbacks only
 * fire when a form omits currentUrl (the kept surfaces always set it), so they
 * default to the surviving investment homes rather than the removed list.
 *
 * They used to fall back to the ficha path built out of `routeAssetId` — the
 * INTERNAL storage id, which is how that id leaked into the address bar (#1318).
 * A holding is named in a URL only by its public `wl_hld_…` id now, and an
 * action holds the internal one, so the honest fallback is the list: the ficha's
 * own URL arrives in `currentUrl` or not at all.
 *
 * Lives outside the action modules on purpose: a `"use server"` file may only
 * export async functions, and every surface needs this one synchronously.
 */
export function currentUrlOf(formData: FormData, fallback = "/patrimonio"): string {
  return (formData.get("currentUrl") as string) || fallback;
}
