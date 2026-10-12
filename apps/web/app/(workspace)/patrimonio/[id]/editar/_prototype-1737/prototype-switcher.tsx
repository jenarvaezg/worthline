"use client";

/**
 * PROTOTIPO #1737 — desechable. La barra flotante que cambia de variante: flechas
 * en pantalla y ← → en el teclado (salvo escribiendo en un campo). No existe en
 * producción.
 */

import { useEffect } from "react";
import styles from "./ficha-prototype.module.css";
import { VARIANTS, type VariantKey } from "./prototype-model";

export function PrototypeSwitcher({
  current,
  onChange,
}: {
  current: VariantKey;
  onChange: (variant: VariantKey) => void;
}) {
  const index = Math.max(
    0,
    VARIANTS.findIndex((variant) => variant.key === current),
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (step === 0) return;
      const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length];
      if (next) onChange(next.key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, onChange]);

  if (process.env.NODE_ENV === "production") return null;

  const cycle = (step: number) => {
    const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length];
    if (next) onChange(next.key);
  };

  return (
    <div aria-label="Variantes del prototipo" className={styles.switcher} role="group">
      <button aria-label="Variante anterior" onClick={() => cycle(-1)} type="button">
        ←
      </button>
      <span>
        Prototipo #1737 · {VARIANTS[index]?.key} ({VARIANTS[index]?.name})
      </span>
      <button aria-label="Variante siguiente" onClick={() => cycle(1)} type="button">
        →
      </button>
    </div>
  );
}
