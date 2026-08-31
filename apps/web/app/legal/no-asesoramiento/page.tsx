import NoAsesoramientoDocument from "@web/legal/_documents/no-asesoramiento";
import { LegalArticle, legalMetadata } from "@web/legal/legal-page";

export const metadata = legalMetadata("no-asesoramiento");

export default function NoAsesoramientoPage() {
  return <LegalArticle Document={NoAsesoramientoDocument} slug="no-asesoramiento" />;
}
