import type { FxExcludedHolding } from "@worthline/domain";

/**
 * The hero's FX-partial note (#1065). Rendered inside the hero, after the
 * data-health alert, ONLY when a holding's currency could not be converted to the
 * base currency — so it was left OUT of the headline total. It names the excluded
 * holdings and states plainly that the figure does not cover them, the honest
 * alternative to silently summing a non-EUR amount as EUR. Nothing renders for an
 * all-EUR portfolio (the common case). Server-rendered, announced as a status.
 */
export default function HeroFxPartial({ excluded }: { excluded: FxExcludedHolding[] }) {
  if (excluded.length === 0) {
    return null;
  }

  const names = excluded.map((holding) => holding.name).join(", ");
  const one = excluded.length === 1;

  return (
    <p className="heroFxPartial" role="status" aria-label="Cifra parcial por divisa">
      <span className="heroFxPartialTag">No incluido · parcial</span>
      <span>
        {one ? "1 holding" : `${excluded.length} holdings`} en otra divisa sin tipo de
        cambio a EUR ({names}); el total no {one ? "lo" : "los"} incluye.
      </span>
    </p>
  );
}
