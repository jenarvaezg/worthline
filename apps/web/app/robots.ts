import type { MetadataRoute } from "next";

import { SITE_URL } from "./site-url";

/**
 * `robots.txt` for the estreno (PRD #877 S6, #954). Only the public surfaces
 * are crawlable; every authenticated workspace route stays out of the index.
 * `force-static` keeps this prerendered alongside the static landing.
 */
export const dynamic = "force-static";

// A denylist (not `Disallow: /` + allowlist) on purpose: Googlebot renders the
// landing to index it, so `/_next/*` assets must stay crawlable — an allowlist
// would starve the render. The trade-off is that this list must name every
// authenticated top-level route; it covers all of them today (`app/*/page.tsx`
// + `scope/route.ts`), and any new private route added later belongs here too.
const PRIVATE_PATHS = [
  "/app",
  "/patrimonio",
  "/historico",
  "/objetivos",
  "/ajustes",
  "/admin",
  "/empezar",
  "/scope",
  "/login",
  "/api/",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
