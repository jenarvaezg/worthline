import type { Metadata } from "next";
import Link from "next/link";

import { formatLegalDate, LEGAL_DOCUMENTS, legalPath } from "./legal-documents";

/**
 * Índice de la cubierta legal (#1172): la puerta a la que apunta el pie de la
 * app y de la landing. Se deriva del registro, así que un texto nuevo aparece
 * aquí solo con darse de alta en `legal-documents.ts`.
 *
 * No lee el entorno a propósito: la identidad del prestador vive en el aviso
 * legal, y así esta página se prerenderiza entera (ver la nota de
 * `legal-page.tsx` sobre `connection()`).
 */

export const metadata: Metadata = {
  alternates: { canonical: "/legal" },
  description:
    "Aviso legal, términos de servicio, privacidad, reembolsos y aviso de no asesoramiento de worthline.",
  title: "Legal",
};

export default function LegalIndexPage() {
  return (
    <article className="legalSheet coverSheet">
      <h2>Legal</h2>

      <p className="legalLede">
        Los textos que rigen worthline, escritos para leerse. Si algo no se entiende, es
        un fallo nuestro: escríbenos a la dirección de contacto del{" "}
        <Link href={legalPath("aviso-legal")}>aviso legal</Link> y lo arreglamos.
      </p>

      <ul className="legalIndex">
        {LEGAL_DOCUMENTS.map((document) => (
          <li key={document.slug}>
            <Link href={legalPath(document.slug)}>{document.title}</Link>
            <p>{document.summary}</p>
            <p className="legalRevision">
              Última actualización: {formatLegalDate(document.updatedAt)}
            </p>
          </li>
        ))}
      </ul>
    </article>
  );
}
