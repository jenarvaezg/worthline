import AvisoLegalDocument from "@web/legal/_documents/aviso-legal";
import { LegalArticle, legalMetadata } from "@web/legal/legal-page";

export const metadata = legalMetadata("aviso-legal");

export default function AvisoLegalPage() {
  return <LegalArticle Document={AvisoLegalDocument} slug="aviso-legal" />;
}
