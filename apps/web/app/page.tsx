import { redirect } from "next/navigation";

/**
 * Provisional root (PRD #877 S1, #949): `/` 307s to `/app` until slice 6
 * replaces it with the public landing. Query params are preserved so legacy
 * deep-links like `/?view=liquid` keep working through the redirect.
 */
export default async function RootRedirect({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const params = new URLSearchParams();

  if (resolved) {
    for (const [key, value] of Object.entries(resolved)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, item);
        }
      } else {
        params.set(key, value);
      }
    }
  }

  const queryString = params.toString();
  redirect(queryString ? `/app?${queryString}` : "/app");
}
