import type { MetadataRoute } from "next";

import { SITE_URL } from "./site-url";

/**
 * Sitemap for the estreno (PRD #877 S6, #954). Lists ONLY the public marketing
 * surfaces — the landing and the demo. Authenticated workspace routes are
 * intentionally absent (they are also disallowed in `robots.ts`).
 * `force-static` keeps this prerendered alongside the static landing.
 */
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/demo`, changeFrequency: "monthly", priority: 0.8 },
  ];
}
