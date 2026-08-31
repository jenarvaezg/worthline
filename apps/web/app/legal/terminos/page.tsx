import TerminosDocument from "@web/legal/_documents/terminos";
import { LegalArticle, legalMetadata } from "@web/legal/legal-page";

export const metadata = legalMetadata("terminos");

export default function TerminosPage() {
  return <LegalArticle Document={TerminosDocument} slug="terminos" />;
}
