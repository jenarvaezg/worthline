import Link from "next/link";

import { LEGAL_DOCUMENTS, legalPath } from "./legal-documents";

/**
 * Los enlaces legales del pie (#1172). El art. 10 de la LSSI pide que la
 * identificación del prestador esté a disposición «permanente, fácil, directa y
 * gratuita», así que los cinco textos cuelgan de cualquier superficie: la
 * landing pública, el umbral de acceso, el selector de demo, el onboarding y el
 * pie de cada página de la app.
 *
 * `<Link>` para no romper el contrato de navegación (`interaction-patterns.md`
 * §5: nunca una recarga de documento), pero `prefetch={false}`: son hojas de
 * salida que casi nadie abre, y cinco prefetch por página serían ruido en cada
 * pantalla del producto.
 */
export default function LegalLinks() {
  return (
    <nav className="legalLinks" aria-label="Textos legales">
      {LEGAL_DOCUMENTS.map((document) => (
        <Link href={legalPath(document.slug)} key={document.slug} prefetch={false}>
          {document.shortTitle}
        </Link>
      ))}
    </nav>
  );
}
