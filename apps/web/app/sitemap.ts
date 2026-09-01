import type { MetadataRoute } from "next";

import { LEGAL_DOCUMENTS, LEGAL_INDEX_PATH, legalPath } from "./legal/legal-documents";
import { SITE_URL } from "./site-url";

/**
 * Sitemap for the estreno (PRD #877 S6, #954). Lists ONLY the public surfaces —
 * the landing, the demo and the legal cover (#1172, whose texts the LSSI wants
 * permanently reachable). Authenticated workspace routes are intentionally
 * absent (they are also disallowed in `robots.ts`).
 * `force-static` keeps this prerendered alongside the static landing.
 */

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/demo`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}${LEGAL_INDEX_PATH}`, changeFrequency: "yearly", priority: 0.3 },
    ...LEGAL_DOCUMENTS.map((document) => ({
      url: `${SITE_URL}${legalPath(document.slug)}`,
      changeFrequency: "yearly" as const,
      priority: 0.3,
      lastModified: document.updatedAt,
    })),
  ];
}
