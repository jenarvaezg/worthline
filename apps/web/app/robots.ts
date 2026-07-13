import type { MetadataRoute } from "next";

import { SITE_URL } from "./site-url";

/**
 * `robots.txt` for the estreno (PRD #877 S6, #954). Only the public surfaces
 * are crawlable; every authenticated workspace route stays out of the index.
 * `force-static` keeps this prerendered alongside the static landing.
 */
export const dynamic = "force-static";

/** Authenticated, private surfaces — never indexed. */
const PRIVATE_PATHS = [
  "/app",
  "/patrimonio",
  "/historico",
  "/objetivos",
  "/ajustes",
  "/admin",
  "/api/",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
