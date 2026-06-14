/**
 * PROTOTIPO #162 — barra flotante para saltar entre variantes. Cero JS: son
 * links a `?variant=`, recargan la página entera (el cambio es inequívoco) y la
 * URL es compartible. La página la oculta en producción.
 */

export const VARIANTS = [
  { key: "A", name: "Libro mayor" },
  { key: "B", name: "Reparto por metal" },
  { key: "C", name: "Galería numismática" },
] as const;

export type VariantKey = (typeof VARIANTS)[number]["key"];

export default function PrototypeSwitcher({ current }: { current: VariantKey }) {
  const idx = VARIANTS.findIndex((v) => v.key === current);
  const prev = VARIANTS[(idx + VARIANTS.length - 1) % VARIANTS.length]!;
  const next = VARIANTS[(idx + 1) % VARIANTS.length]!;
  const active = VARIANTS[idx]!;

  return (
    <nav className="np-switcher" aria-label="Variantes del prototipo">
      <a href={`/prototipo-numista?variant=${prev.key}`} aria-label="Variante anterior">
        ‹
      </a>
      <span className="np-switcherLabel">
        {active.key} — {active.name}
        <small>
          variante {idx + 1} de {VARIANTS.length}
        </small>
      </span>
      <a href={`/prototipo-numista?variant=${next.key}`} aria-label="Variante siguiente">
        ›
      </a>
    </nav>
  );
}
