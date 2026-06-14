/**
 * PROTOTIPO #162 — «Prototipa la UX de la colección de monedas». DESECHABLE.
 *
 * Pregunta que responde: ¿qué pinta debe tener la colección Numista en sus tres
 * superficies — la línea agregada en Patrimonio, el detalle del catálogo
 * agrupado por metal, y el flujo de conectar/sincronizar? Tres direcciones
 * radicalmente distintas, conmutables con `?variant=A|B|C`, sobre datos mock y
 * dentro del Shell real para juzgarlas con el cromo y la densidad de la app.
 *
 * Una vez elegida la dirección (ver NOTES.md), este directorio entero se borra y
 * la decisión se lleva a S2/S7. No promocionar este código a producción.
 */

import { redirect } from "next/navigation";

import Shell from "../shell";
import { COLLECTION_COIN_COUNT, zeroValueCount, MOCK_COINS } from "./mock-collection";
import PrototypeStyles from "./prototype-styles";
import PrototypeSwitcher, { VARIANTS, type VariantKey } from "./prototype-switcher";
import VariantGallery from "./variant-gallery";
import VariantLedger from "./variant-ledger";
import VariantPanel from "./variant-panel";

export const dynamic = "force-dynamic";

function parseVariant(raw: string | string[] | undefined): VariantKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (VARIANTS.find((v) => v.key === value)?.key ?? "A") as VariantKey;
}

export default async function PrototipoNumistaPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Nunca debe existir en producción: el prototipo es solo para desarrollo.
  if (process.env.NODE_ENV === "production") {
    redirect("/patrimonio");
  }

  const resolved = await searchParams;
  const variant = parseVariant(resolved?.variant);

  const zeros = zeroValueCount(MOCK_COINS);

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl={`/prototipo-numista?variant=${variant}`}
      persistence={{
        checkedAt: "2026-06-14T11:20:00.000Z",
        displayPath: "~/.worthline/worthline.sqlite",
      }}
      scopes={[]}
      selectedScopeId={undefined}
      warnings={
        zeros > 0
          ? [
              {
                code: "value-at-zero",
                entityId: "numista-collection",
                message: `Colección Numista: ${zeros} moneda${
                  zeros === 1 ? "" : "s"
                } con valor 0`,
              },
            ]
          : []
      }
    >
      <PrototypeStyles />

      <div className="np-banner">
        <strong>Prototipo desechable · #162</strong>
        <span>
          UX de la colección Numista — {COLLECTION_COIN_COUNT} monedas mock, sin red ni
          BD. Cambia de dirección con la barra inferior. Se borra al elegir (ver
          NOTES.md).
        </span>
      </div>

      {variant === "A" && <VariantLedger />}
      {variant === "B" && <VariantPanel />}
      {variant === "C" && <VariantGallery />}

      <PrototypeSwitcher current={variant} />
    </Shell>
  );
}
