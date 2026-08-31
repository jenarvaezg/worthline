/**
 * Registro de los textos legales publicados (#1172, PRD #1171 S1).
 *
 * Fuente única de la cubierta legal: el índice, la navegación entre documentos,
 * los enlaces del pie (app, landing y umbral) y el sitemap se derivan de aquí,
 * de modo que publicar un texto nuevo es añadir una entrada y su `page.tsx`, y
 * nunca actualizar cinco listas a mano.
 *
 * Los cinco documentos son el checklist accionable del research
 * `docs/research/2026-07-18-minimo-legal-salida.md` (#1136): aviso legal (LSSI
 * art. 10), términos, privacidad (RGPD arts. 13-14), reembolsos (lo exige el
 * merchant of record) y el disclaimer de no-asesoramiento (perímetro CNMV,
 * ADR 0045).
 */

import type { LegalIdentity } from "./legal-identity";

/**
 * Todo documento legal recibe la identidad del prestador: quién responde, con
 * qué NIF y a qué correo se le escribe. Uniforme para los cinco aunque alguno
 * solo necesite el correo — así el índice, el layout y los tests los tratan
 * igual.
 */
export type LegalDocumentProps = { identity: LegalIdentity };

export type LegalDocumentSlug =
  | "aviso-legal"
  | "no-asesoramiento"
  | "privacidad"
  | "reembolsos"
  | "terminos";

export type LegalDocument = {
  /** Etiqueta del pie, donde no cabe el título completo. */
  shortTitle: string;
  /** Frase de una línea para el índice y para `metadata.description`. */
  summary: string;
  slug: LegalDocumentSlug;
  title: string;
  /** Fecha de la última revisión del texto, en ISO (`YYYY-MM-DD`). */
  updatedAt: string;
};

export const LEGAL_INDEX_PATH = "/legal";

/** Fecha de redacción de esta primera versión completa de los cinco textos. */
const FIRST_PUBLICATION = "2026-08-31";

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  {
    shortTitle: "Aviso legal",
    slug: "aviso-legal",
    summary:
      "Quién presta el servicio, con qué NIF y cómo contactar de forma directa y efectiva.",
    title: "Aviso legal",
    updatedAt: FIRST_PUBLICATION,
  },
  {
    shortTitle: "Términos",
    slug: "terminos",
    summary:
      "Qué es worthline y qué no, los planes, el compromiso del lifetime y las reglas del servicio.",
    title: "Términos de servicio",
    updatedAt: FIRST_PUBLICATION,
  },
  {
    shortTitle: "Privacidad",
    slug: "privacidad",
    summary:
      "Qué datos se tratan, con qué base jurídica, quién los procesa y cómo ejercer tus derechos.",
    title: "Política de privacidad",
    updatedAt: FIRST_PUBLICATION,
  },
  {
    shortTitle: "Reembolsos",
    slug: "reembolsos",
    summary:
      "Catorce días para deshacer cualquier compra, suscripción o lifetime, sin dar explicaciones.",
    title: "Política de reembolsos",
    updatedAt: FIRST_PUBLICATION,
  },
  {
    shortTitle: "No asesoramiento",
    slug: "no-asesoramiento",
    summary:
      "worthline informa y calcula; no recomienda comprar ni vender, ni custodia tu dinero.",
    title: "Aviso de no asesoramiento",
    updatedAt: FIRST_PUBLICATION,
  },
] as const;

export function legalPath(slug: LegalDocumentSlug): string {
  return `${LEGAL_INDEX_PATH}/${slug}`;
}

export function legalDocument(slug: LegalDocumentSlug): LegalDocument {
  const document = LEGAL_DOCUMENTS.find((candidate) => candidate.slug === slug);

  if (!document) throw new Error(`Documento legal desconocido: ${slug}`);

  return document;
}

/**
 * «2026-08-31» → «31 de agosto de 2026». Se formatea en UTC a propósito: al
 * oeste de Greenwich un ISO de fecha suelta interpretado en zona local retrocede
 * un día, y la fecha de revisión de un texto legal no puede depender de dónde
 * corra el build.
 */
export function formatLegalDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });
}
