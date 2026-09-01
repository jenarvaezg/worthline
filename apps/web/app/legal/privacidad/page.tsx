import PrivacidadDocument from "@web/legal/_documents/privacidad";
import { LegalArticle, legalMetadata } from "@web/legal/legal-page";

export const metadata = legalMetadata("privacidad");

export default function PrivacidadPage() {
  return <LegalArticle Document={PrivacidadDocument} slug="privacidad" />;
}
