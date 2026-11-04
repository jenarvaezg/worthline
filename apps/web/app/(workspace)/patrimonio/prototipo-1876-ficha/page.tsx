import { notFound } from "next/navigation";
import { Suspense } from "react";
import FichaPrototype from "./ficha-prototype";
import SyncPrototype from "./sync-prototype";

/**
 * PROTOTIPO #1882 (y siguientes del PRD #1876) — desechable. La ficha de un holding
 * enlazado con MyInvestor, pintada con el componente real de la ficha (#1826) y
 * datos inventados. `?s7=A|B|C&caso=externo|interno|sin-candidato` o `?s9=A|B|C`.
 */
export const instant = false;

export const metadata = {
  title: "Prototipo ficha MyInvestor · worthline",
};

export default function PrototipoFichaMyInvestorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return (
    <Suspense fallback={null}>
      <WhichPrototype searchParams={searchParams} />
    </Suspense>
  );
}

/** `?s9=` monta «Poner al día» y la salud (#1884/#1885); si no, el coste heredado (#1882). */
async function WhichPrototype({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return params.s9 ? <SyncPrototype /> : <FichaPrototype />;
}
