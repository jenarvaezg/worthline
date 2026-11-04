import { notFound } from "next/navigation";
import { Suspense } from "react";
import FichaPrototype from "./ficha-prototype";

/**
 * PROTOTIPO #1882 (y siguientes del PRD #1876) — desechable. La ficha de un holding
 * enlazado con MyInvestor, pintada con el componente real de la ficha (#1826) y
 * datos inventados. `?s7=A|B|C&caso=externo|interno|sin-candidato`.
 */
export const instant = false;

export const metadata = {
  title: "Prototipo ficha MyInvestor · worthline",
};

export default function PrototipoFichaMyInvestorPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return (
    <Suspense fallback={null}>
      <FichaPrototype />
    </Suspense>
  );
}
