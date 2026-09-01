import ReembolsosDocument from "@web/legal/_documents/reembolsos";
import { LegalArticle, legalMetadata } from "@web/legal/legal-page";

export const metadata = legalMetadata("reembolsos");

export default function ReembolsosPage() {
  return <LegalArticle Document={ReembolsosDocument} slug="reembolsos" />;
}
