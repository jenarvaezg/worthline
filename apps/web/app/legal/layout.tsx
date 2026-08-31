import Link from "next/link";

import { LEGAL_DOCUMENTS, LEGAL_INDEX_PATH, legalPath } from "./legal-documents";

/**
 * Cubierta legal (#1172). Registro de cubierta según #829/#909: los textos
 * legales rodean el libro —no son trabajo—, así que van sobre tinta con filete
 * dorado, con el cuerpo del documento en la hoja luminosa encartada
 * (`.coverSheet`) para que un texto largo se lea sobre papel.
 *
 * Rutas estáticas por construcción: no leen cookies ni store, solo el registro
 * de documentos y la identidad del prestador desde el entorno.
 */
export default function LegalLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="legalPage coverSurface">
      <header className="legalMasthead">
        <Link className="brand legalBrand" href="/">
          <span className="brandMark" aria-hidden="true">
            wl
          </span>
          <div>
            <h1>worthline</h1>
            <p>Textos legales</p>
          </div>
        </Link>
      </header>

      {children}

      <nav className="legalNav" aria-label="Textos legales">
        <Link href={LEGAL_INDEX_PATH}>Índice</Link>
        {LEGAL_DOCUMENTS.map((document) => (
          <Link href={legalPath(document.slug)} key={document.slug}>
            {document.title}
          </Link>
        ))}
      </nav>
    </main>
  );
}
