import type { CompositionRange } from "@worthline/domain";

/**
 * Server-rendered range controls for the composition chart (#144, ADR 0009):
 * the temporal window is URL state, not a client pan/zoom gesture, so this is a
 * plain set of pill links. Only the ranges the history actually spans are
 * offered (computed upstream via `availableCompositionRanges`); with a single
 * option the control hides itself — there is nothing to choose between.
 */

const RANGE_LABELS: Record<CompositionRange, string> = {
  "1y": "1A",
  "3y": "3A",
  "5y": "5A",
  all: "Todo",
};

export default function CompositionRangeControls({
  options,
  selected,
}: {
  /** Ranges to offer, each with its target URL (range set, Vista/drill preserved). */
  options: Array<{ range: CompositionRange; href: string }>;
  selected: CompositionRange;
}) {
  // Under a year of history → only "Todo" qualifies; no control to show.
  if (options.length < 2) {
    return null;
  }

  return (
    <nav className="rangeTabs" aria-label="Rango temporal de la composición">
      {options.map(({ href, range }) => {
        const isActive = range === selected;

        return (
          <a
            aria-current={isActive ? "true" : undefined}
            className={isActive ? "active" : undefined}
            href={href}
            key={range}
          >
            {RANGE_LABELS[range]}
          </a>
        );
      })}
    </nav>
  );
}
