import LandingContent from "@web/landing/landing-content";
import WorkspaceLegalFooter from "@web/workspace-legal-footer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { LEGAL_DOCUMENTS, legalPath } from "./legal-documents";
import LegalLinks from "./legal-links";

/**
 * El art. 10 de la LSSI pide que la identificación del prestador esté a
 * disposición «permanente, fácil, directa y gratuita». Eso se traduce en un
 * requisito comprobable (#1172): desde cualquier superficie de worthline —la
 * landing pública y el pie de la app— se llega a los cinco textos en un clic.
 */

describe("legal links (#1172)", () => {
  test("links every registered document by its short label", () => {
    const html = renderToStaticMarkup(<LegalLinks />);

    for (const document of LEGAL_DOCUMENTS) {
      expect(html, document.slug).toContain(`href="${legalPath(document.slug)}"`);
      expect(html, document.slug).toContain(document.shortTitle);
    }
  });

  test("the workspace footer carries them on every page of the app", () => {
    const html = renderToStaticMarkup(<WorkspaceLegalFooter />);

    for (const document of LEGAL_DOCUMENTS) {
      expect(html, document.slug).toContain(`href="${legalPath(document.slug)}"`);
    }
  });

  test("the public landing carries them in its colophon", () => {
    const html = renderToStaticMarkup(<LandingContent />);

    for (const document of LEGAL_DOCUMENTS) {
      expect(html, document.slug).toContain(`href="${legalPath(document.slug)}"`);
    }
  });
});
