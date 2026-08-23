import { notFound } from "next/navigation";
import { Suspense } from "react";

import ManagedPortfolioGroupPrototype from "./managed-portfolio-group-prototype";

/**
 * Block (#1229): this route opts out of Instant Navigations validation — same
 * reason as the other prototype routes under /patrimonio.
 */
export const instant = false;

export const metadata = {
  title: "Prototipo cartera gestionada en la lista · worthline",
};

export default function PrototipoCarteraGrupoPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <Suspense>
      <ManagedPortfolioGroupPrototype />
    </Suspense>
  );
}
