import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import {
  formatLegalDate,
  type LegalDocumentProps,
  type LegalDocumentSlug,
  legalDocument,
  legalPath,
} from "./legal-documents";
import { readLegalIdentity } from "./legal-identity";

/**
 * El marco compartido de un texto legal (#1172): la hoja luminosa encartada en
 * la cubierta (`.coverSheet`, canon #862/#909) y la fecha de revisión al pie.
 *
 * **Por qué el cuerpo va en `<Suspense>` detrás de `connection()`**: la identidad
 * del prestador vive en variables de entorno del despliegue. Sin `connection()`,
 * `process.env` se lee también durante el prerender del build, y el shell
 * estático se queda congelado con los valores de ESE entorno; cuando el runtime
 * tiene otros (o los tiene y el build no), el HTML servido y el árbol de React
 * dejan de coincidir y la hidratación falla — se ve como el error 418 de React.
 * `connection()` saca esta parte del prerender: el texto se resuelve siempre con
 * el entorno que sirve la petición, así que cambiar la variable y redesplegar
 * basta, sin depender de que el build la tuviera.
 *
 * La `metadata` de cada ruta se deriva del mismo registro que el índice y el
 * sitemap, para que el título de la pestaña y el del documento no diverjan.
 */

type LegalDocumentComponent = (props: LegalDocumentProps) => React.ReactNode;

export function legalMetadata(slug: LegalDocumentSlug): Metadata {
  const document = legalDocument(slug);

  return {
    alternates: { canonical: legalPath(slug) },
    description: document.summary,
    title: document.title,
  };
}

export function LegalArticle({
  Document,
  slug,
}: {
  Document: LegalDocumentComponent;
  slug: LegalDocumentSlug;
}) {
  const document = legalDocument(slug);

  return (
    <article className="legalSheet coverSheet">
      <Suspense fallback={<LegalArticleSkeleton title={document.title} />}>
        <LegalArticleBody Document={Document} />
      </Suspense>

      <p className="legalRevision">
        Última actualización: {formatLegalDate(document.updatedAt)}
      </p>
    </article>
  );
}

async function LegalArticleBody({ Document }: { Document: LegalDocumentComponent }) {
  await connection();

  return <Document identity={readLegalIdentity()} />;
}

/** El título sí es estático: sale del registro, no del entorno. */
function LegalArticleSkeleton({ title }: { title: string }) {
  return (
    <div aria-busy="true">
      <h2>{title}</h2>
      <div className="skeletonTier" />
      <div className="skeletonTier" />
      <div className="skeletonTier" />
    </div>
  );
}
