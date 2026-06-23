"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import type {
  CompositionHousingMode,
  CompositionRange,
  CompositionSeriesPoint,
  DrilldownKey,
  NetWorthFraming,
} from "@worthline/domain";

import CompositionChart from "./composition-chart";
import {
  FRAMING_VIEW_PARAM,
  RANGE_VIEW_PARAM,
  readViewParam,
  retargetHref,
  VIEW_STATE_CHANGE_EVENT,
  writeViewParam,
} from "./view-state";

/**
 * The composition chart's temporal-range control as a client island (S3 #519,
 * ADR 0036, Phase 0 — built on the #518 toggle base in `view-state`).
 *
 * The range pills (1A/3A/5A/Todo) used to be server `<a>` links: each click paid
 * the ~2.3s Turso round-trip the S0 baseline measured (#516). Now the server
 * ships the chart series for EVERY offered range at once and this island swaps
 * between them instantly on click — no round-trip — mirroring the choice to the
 * URL via `history.pushState` (interaction-patterns §2/§3). Deep-link and reload
 * still read `range` from the URL (the server renders the right window); Back /
 * Forward re-read it via `popstate`.
 *
 * It composes with the Vista island (#518) THROUGH THE URL, never by reference:
 * each island writes only its own param, so a link this island rebuilds carries
 * both the range it just toggled and whatever framing the URL currently holds —
 * read live so a client framing toggle since render is respected (§3). The pure
 * toggle/URL logic is `view-state`; this component is the thin pushState/popstate
 * shell (the established `composition-chart-hover` split, §7).
 */

const RANGE_LABELS: Record<CompositionRange, string> = {
  "1y": "1A",
  "3y": "3A",
  "5y": "5A",
  all: "Todo",
};

/** Spoken label for the live region — a pill abbreviation alone is opaque to SR. */
const RANGE_ANNOUNCE: Record<CompositionRange, string> = {
  "1y": "1 año",
  "3y": "3 años",
  "5y": "5 años",
  all: "todo el histórico",
};

/**
 * Rewrite the `range` param of the page's OTHER same-page range-bearing links —
 * the liquidity donut's drill segments — so a later server navigation keeps the
 * client-toggled window (interaction-patterns §3). It mirrors the Vista island's
 * `syncSiblingViewLinks` (#518) for the range dimension: same-page only (the
 * "Ver histórico" link points elsewhere), and the history panel's own links are
 * skipped because this island already renders them with the live range.
 */
function syncSiblingRangeLinks(range: CompositionRange): void {
  const grid = document.querySelector(".dashGrid");
  if (!grid) {
    return;
  }
  for (const anchor of grid.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (anchor.closest(".historyPanel") || anchor.closest(".framingTabs")) {
      continue;
    }
    const href = anchor.getAttribute("href");
    if (!href) {
      continue;
    }
    const url = new URL(href, window.location.origin);
    if (url.pathname !== window.location.pathname) {
      continue;
    }
    anchor.setAttribute("href", retargetHref(href, [[RANGE_VIEW_PARAM, range]]));
  }
}

export interface CompositionRangeOption {
  range: CompositionRange;
  /** Server-built URL for this range — the no-JS fallback and the deep-link. */
  href: string;
}

export default function CompositionPanel({
  currency,
  drillHrefs,
  historicoLink,
  housingMode,
  housingToggleHref,
  initialRange,
  initialView,
  privacyMode,
  rangeOptions,
  seriesByRange,
}: {
  currency: string;
  /** Per-group drill URLs (request-time): retargeted to the live range + view. */
  drillHrefs: Partial<Record<DrilldownKey, string>>;
  /** The "Ver histórico →" link — static chrome the server renders, slotted in. */
  historicoLink: ReactNode;
  housingMode: CompositionHousingMode;
  /** "Ocultar/Mostrar vivienda" URL (request-time): retargeted like the drills. */
  housingToggleHref: string;
  initialRange: CompositionRange;
  initialView: NetWorthFraming;
  privacyMode: boolean;
  /** Offered ranges with their server-built hrefs; under 2, the pills hide. */
  rangeOptions: readonly CompositionRangeOption[];
  seriesByRange: Partial<Record<CompositionRange, CompositionSeriesPoint[]>>;
}) {
  const [range, setRange] = useState<CompositionRange>(initialRange);
  // The framing the URL currently holds. A range toggle does not change it, but
  // the sibling Vista island (#518) may have pushed a new one since this island
  // rendered — `pushState` fires no event, so we cannot subscribe to it. We read
  // it live on every toggle (and on popstate) and fold it into the links we
  // rebuild, so the two islands stay consistent through the URL.
  const [view, setView] = useState<NetWorthFraming>(initialView);

  // Re-read range + framing from the URL on Back/Forward (popstate) and on a
  // bfcache restore (pageshow.persisted) — neither re-runs SSR, so the island
  // reconciles with the URL itself (same pattern as the Vista island).
  useEffect(() => {
    const syncFromUrl = () => {
      setRange(readViewParam(window.location.search, RANGE_VIEW_PARAM));
      setView(readViewParam(window.location.search, FRAMING_VIEW_PARAM));
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        syncFromUrl();
      }
    };
    window.addEventListener("popstate", syncFromUrl);
    window.addEventListener("pageshow", onPageShow);
    // The Vista island (#518) pushes `view` without a native event; its nudge
    // lets this island refresh the framing it folds into the links it rebuilds,
    // so the two compose through the URL even between range toggles (§3).
    window.addEventListener(VIEW_STATE_CHANGE_EVENT, syncFromUrl);
    return () => {
      window.removeEventListener("popstate", syncFromUrl);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener(VIEW_STATE_CHANGE_EVENT, syncFromUrl);
    };
  }, []);

  // Keep the page's other range-bearing server links (the donut) on the live range.
  useEffect(() => {
    syncSiblingRangeLinks(range);
  }, [range]);

  const select = (next: CompositionRange) => (event: MouseEvent<HTMLAnchorElement>) => {
    // Let modified clicks (new tab/window) and non-primary buttons navigate.
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    if (next === readViewParam(window.location.search, RANGE_VIEW_PARAM)) {
      return;
    }
    const liveView = readViewParam(window.location.search, FRAMING_VIEW_PARAM);
    const nextSearch = writeViewParam(window.location.search, RANGE_VIEW_PARAM, next);
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${nextSearch}${window.location.hash}`,
    );
    setRange(next);
    setView(liveView);
    // Nudge sibling islands to re-read range from the URL (symmetric with #518).
    window.dispatchEvent(new Event(VIEW_STATE_CHANGE_EVENT));
  };

  // Retarget a request-time link to the live range + framing (§3), so drilling
  // or toggling vivienda after a client range/view switch keeps both choices.
  const retarget = (href: string): string =>
    retargetHref(href, [
      [RANGE_VIEW_PARAM, range],
      [FRAMING_VIEW_PARAM, view],
    ]);

  const liveDrillHrefs = Object.fromEntries(
    Object.entries(drillHrefs).map(([key, href]) => [key, retarget(href)]),
  ) as Partial<Record<DrilldownKey, string>>;
  const liveHousingToggleHref = retarget(housingToggleHref);

  return (
    <>
      <div className="panelHeader">
        <h2>Evolución</h2>
        <div className="historyControls">
          {rangeOptions.length >= 2 ? (
            <nav className="rangeTabs" aria-label="Rango temporal de la composición">
              {rangeOptions.map((option) => {
                const isActive = option.range === range;
                return (
                  <a
                    aria-current={isActive ? "true" : undefined}
                    className={isActive ? "active" : undefined}
                    href={retargetHref(option.href, [[FRAMING_VIEW_PARAM, view]])}
                    key={option.range}
                    onClick={select(option.range)}
                  >
                    {RANGE_LABELS[option.range]}
                  </a>
                );
              })}
            </nav>
          ) : null}
          {historicoLink}
        </div>
      </div>
      {/* Announce the window change for screen readers — a client toggle is not a
          document navigation, so it is not announced otherwise (§8). */}
      <p aria-live="polite" className="srOnly">{`Rango: ${RANGE_ANNOUNCE[range]}`}</p>
      <CompositionChart
        currency={currency}
        drillHrefs={liveDrillHrefs}
        housingMode={housingMode}
        housingToggleHref={liveHousingToggleHref}
        points={seriesByRange[range] ?? []}
        privacyMode={privacyMode}
      />
    </>
  );
}
