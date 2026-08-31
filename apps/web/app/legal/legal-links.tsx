import { LEGAL_DOCUMENTS, legalPath } from "./legal-documents";

/**
 * Los enlaces legales del pie (#1172). El art. 10 de la LSSI pide que la
 * identificación del prestador esté a disposición «permanente, fácil, directa y
 * gratuita», así que los cinco textos cuelgan de cualquier superficie: la
 * landing pública, el umbral de acceso y el pie de cada página de la app.
 *
 * `<a>` y no `<Link>`: el pie vive en superficies estáticas (la landing
 * prerenderizada incluida) y estos destinos son hojas de salida, no navegación
 * de trabajo — no hay nada que prefetch justifique.
 */
export default function LegalLinks() {
  return (
    <nav className="legalLinks" aria-label="Textos legales">
      {LEGAL_DOCUMENTS.map((document) => (
        <a href={legalPath(document.slug)} key={document.slug}>
          {document.shortTitle}
        </a>
      ))}
    </nav>
  );
}
