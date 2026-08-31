import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  formatLegalDate,
  LEGAL_DOCUMENTS,
  LEGAL_INDEX_PATH,
  legalPath,
} from "./legal-documents";

/**
 * El registro de textos legales (#1172) es la fuente única: de él salen el
 * índice, la navegación entre documentos, los enlaces del pie y el sitemap. Si
 * un documento del checklist del research (#1136) no está aquí, no está en
 * ningún pie — que es justo lo que la LSSI exige que sea permanente y fácil.
 */

const CHECKLIST_SLUGS = [
  "aviso-legal",
  "terminos",
  "privacidad",
  "reembolsos",
  "no-asesoramiento",
];

describe("legal documents registry (#1172)", () => {
  test("carries the five texts of the minimum-legal checklist", () => {
    expect(LEGAL_DOCUMENTS.map((document) => document.slug)).toEqual(CHECKLIST_SLUGS);
  });

  test("every document has a route on disk under /legal", () => {
    for (const document of LEGAL_DOCUMENTS) {
      const page = join(import.meta.dirname, document.slug, "page.tsx");

      expect(existsSync(page), `${document.slug} has no page.tsx`).toBe(true);
      expect(legalPath(document.slug)).toBe(`${LEGAL_INDEX_PATH}/${document.slug}`);
    }
  });

  test("every document announces a title and a one-line summary", () => {
    for (const document of LEGAL_DOCUMENTS) {
      expect(document.title.length, document.slug).toBeGreaterThan(3);
      expect(document.summary.length, document.slug).toBeGreaterThan(20);
      expect(document.updatedAt, document.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("formats the revision date the way a Spanish reader reads it", () => {
    // Fijado en UTC: un `new Date("2026-08-31")` interpretado en zona local
    // retrocedería un día al oeste de Greenwich y publicaría otra fecha.
    expect(formatLegalDate("2026-08-31")).toBe("31 de agosto de 2026");
  });
});
