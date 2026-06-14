import type { PortfolioGroupKey } from "@worthline/domain";

/**
 * Server-rendered grouping controls for the unified /patrimonio holdings list
 * (#154, PRD #146 S8, ADR 0009). How the list is grouped is URL state, not a
 * client gesture, so this is a plain set of pill links (mirrors the dashboard's
 * range/Vista controls). The active axis inverts to ink. The grouping is also the
 * filter: the page renders the holdings bucketed by the chosen axis.
 */

const GROUP_LABELS: Record<PortfolioGroupKey, string> = {
  direction: "Activos/Pasivos",
  rung: "Liquidez",
  instrument: "Instrumento",
};

const GROUP_ORDER: PortfolioGroupKey[] = ["direction", "rung", "instrument"];

export default function PatrimonioGroupControls({
  selected,
  hrefFor,
}: {
  selected: PortfolioGroupKey;
  /** Build the URL that selects a grouping axis (scope/feedback preserved upstream). */
  hrefFor: (group: PortfolioGroupKey) => string;
}) {
  return (
    <nav className="rangeTabs" aria-label="Agrupar holdings">
      {GROUP_ORDER.map((group) => {
        const isActive = group === selected;

        return (
          <a
            aria-current={isActive ? "true" : undefined}
            className={isActive ? "active" : undefined}
            href={hrefFor(group)}
            key={group}
          >
            {GROUP_LABELS[group]}
          </a>
        );
      })}
    </nav>
  );
}
