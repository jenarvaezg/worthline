import { redirect } from "next/navigation";

/**
 * Provisional root (PRD #877 S1, #949): `/` 307s to `/app` until slice 6
 * replaces it with the public landing. The gate treats `/` as public so this
 * redirect is reachable without a session.
 */
export default function RootRedirect() {
  redirect("/app");
}
