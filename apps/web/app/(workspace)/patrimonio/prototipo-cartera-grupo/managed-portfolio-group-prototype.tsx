"use client";

/**
 * PROTOTIPO DESECHABLE (#1548) — «¿cómo se pinta una cartera gestionada en la
 * lista de /patrimonio?».
 *
 * Cuatro variantes radicalmente distintas de lo mismo, en la ruta de patrimonio
 * y con las clases del tablero real, sobre la Cartera Indexada Metal de Jorge.
 * Se cambia de variante con la barra flotante (o ← →); los ejes de agrupación
 * y el estado colapsado/expandido son controles de la propia página, porque la
 * pregunta de #1548 se juega justo ahí: la cartera tiene que seguir siendo UN
 * sumando se mire por donde se mire.
 *
 * No hay BD, ni acciones, ni persistencia: fixture en memoria.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { money, pct } from "./board-bits";
import {
  AXIS_LABELS,
  type Axis,
  type BucketMode,
  buildUnits,
  instrumentBucket,
  sectionsFor,
  sumUnits,
  type Unit,
} from "./grouping";
import styles from "./prototipo-cartera-grupo.module.css";
import PrototypeSwitcher from "./prototype-switcher";
import VariantA, { VARIANT_A_NAME } from "./variant-a-subseccion";
import VariantB, { VARIANT_B_NAME } from "./variant-b-mini-panel";
import VariantC, { VARIANT_C_NAME } from "./variant-c-cajon";
import VariantD, { VARIANT_D_NAME } from "./variant-d-seccion-propia";
import VariantE, { VARIANT_E_NAME } from "./variant-e-mezcla";

const VARIANTS = [
  { key: "e", name: VARIANT_E_NAME },
  { key: "a", name: VARIANT_A_NAME },
  { key: "b", name: VARIANT_B_NAME },
  { key: "c", name: VARIANT_C_NAME },
  { key: "d", name: VARIANT_D_NAME },
];

/** La mezcla es la que gana el default: es el candidato a implementar. */
const DEFAULT_VARIANT = "e";

const AXES: Axis[] = ["direction", "rung", "instrument"];

const BUCKET_LABELS: Record<BucketMode, string> = {
  dominant: "hereda «Fondo»",
  own: "bucket propio",
};

export default function ManagedPortfolioGroupPrototype() {
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);

  const variant = params.get("variant") ?? DEFAULT_VARIANT;
  const axis = (params.get("eje") as Axis | null) ?? "direction";
  const bucketMode = (params.get("bucket") as BucketMode | null) ?? "own";

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  const units = buildUnits();
  const { assets, liabilities } = sectionsFor(units, axis, bucketMode);

  // El estado, a la vista: los sumandos tienen que cuadrar con el bruto en
  // ambos estados de plegado, y la cartera tiene que aparecer una sola vez.
  const gross = units
    .filter((u) => u.direction === "asset")
    .reduce((sum, u) => sum + u.amountMinor, 0);
  const shown = sumUnits(assets);
  const metal = units.find((u): u is Extract<Unit, { kind: "portfolio" }> => {
    return u.kind === "portfolio";
  });
  const bucket = metal ? instrumentBucket(metal, bucketMode) : null;
  const landsIn =
    axis === "direction"
      ? "Activos"
      : axis === "rung"
        ? "Mercado (escalón dominante)"
        : (bucket?.label ?? "—");

  const props = { assets, liabilities, onToggle: () => setOpen((v) => !v), open };

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <p>Prototipo desechable · #1548 · datos de la Metal de Jorge (19-08)</p>
        <h1>La cartera gestionada en la lista</h1>
        <p className={styles.lede}>
          Cuatro formas de pintar el mismo grupo. Cambia de variante con ← → o con la
          barra de abajo; cambia el eje y el plegado aquí arriba y comprueba que la
          cartera sigue siendo un solo sumando.
        </p>
      </header>

      <div className={styles.controls}>
        <nav aria-label="Agrupar activos" className="rangeTabs">
          {AXES.map((option) => (
            <button
              aria-current={option === axis ? "true" : undefined}
              className={`${styles.pill} ${option === axis ? styles.pillActive : ""}`}
              key={option}
              onClick={() => setParam("eje", option)}
              type="button"
            >
              {AXIS_LABELS[option]}
            </button>
          ))}
        </nav>

        <nav
          aria-label="Bucket de la cartera en el eje instrumento"
          className="rangeTabs"
        >
          {(["own", "dominant"] as BucketMode[]).map((option) => (
            <button
              aria-current={option === bucketMode ? "true" : undefined}
              className={`${styles.pill} ${option === bucketMode ? styles.pillActive : ""}`}
              key={option}
              onClick={() => setParam("bucket", option)}
              type="button"
            >
              {BUCKET_LABELS[option]}
            </button>
          ))}
        </nav>

        <button className={styles.toggleAll} onClick={props.onToggle} type="button">
          {open ? "Colapsar la cartera" : "Expandir la cartera"}
        </button>
      </div>

      <dl className={styles.state}>
        <div>
          <dt>Σ sumandos (activos)</dt>
          <dd>{money(shown)}</dd>
        </div>
        <div>
          <dt>Bruto del fixture</dt>
          <dd>{money(gross)}</dd>
        </div>
        <div>
          <dt>Invariante</dt>
          <dd className={shown === gross ? styles.ok : styles.bad}>
            {shown === gross ? "Σ filas = bruto ✓" : "descuadra ✗"}
          </dd>
        </div>
        <div>
          <dt>La Metal cae en</dt>
          <dd>{landsIn}</dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>{open ? "expandida (desglose)" : "colapsada (sumando)"}</dd>
        </div>
        <div>
          <dt>Deriva vs testigo</dt>
          <dd>{metal ? pct(metal.drift, 2) : "—"}</dd>
        </div>
      </dl>

      {variant === "a" ? <VariantA {...props} /> : null}
      {variant === "b" ? <VariantB {...props} /> : null}
      {variant === "c" ? <VariantC {...props} /> : null}
      {variant === "d" ? <VariantD {...props} /> : null}
      {variant !== "a" && variant !== "b" && variant !== "c" && variant !== "d" ? (
        <VariantE {...props} />
      ) : null}

      <PrototypeSwitcher
        current={variant}
        onSelect={(key) => setParam("variant", key)}
        variants={VARIANTS}
      />
    </div>
  );
}
