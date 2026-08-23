"use client";

/**
 * PROTOTIPO (#1548) — la barra flotante para saltar de variante.
 *
 * Deliberadamente fea y de alto contraste: tiene que verse que NO forma parte
 * del diseño que se está juzgando. Flechas ← → del teclado también, salvo
 * cuando el foco está en un campo de texto.
 */

import { useEffect } from "react";

import styles from "./prototipo-cartera-grupo.module.css";

export interface VariantEntry {
  key: string;
  name: string;
}

export default function PrototypeSwitcher({
  variants,
  current,
  onSelect,
}: {
  variants: VariantEntry[];
  current: string;
  onSelect: (key: string) => void;
}) {
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const step = (delta: number) => {
    const next = variants[(index + delta + variants.length) % variants.length];
    if (next) onSelect(next.key);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const active = variants[index];

  return (
    <div className={styles.switcher}>
      <button
        aria-label="Variante anterior"
        className={styles.switcherBtn}
        onClick={() => step(-1)}
        type="button"
      >
        ←
      </button>
      <span className={styles.switcherLabel}>
        {active ? `${active.key.toUpperCase()} — ${active.name}` : "—"}
      </span>
      <button
        aria-label="Variante siguiente"
        className={styles.switcherBtn}
        onClick={() => step(1)}
        type="button"
      >
        →
      </button>
    </div>
  );
}
