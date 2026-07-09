"use client";

import type {
  CompositionHousingMode,
  CompositionRange,
  DrilldownKey,
  NetWorthFraming,
} from "@worthline/domain";
import { type MouseEvent, useCallback, useEffect, useState } from "react";

import { compositionUrl } from "./composition-url";
import {
  FRAMING_VIEW_PARAM,
  RANGE_VIEW_PARAM,
  readViewParam,
  VIEW_STATE_CHANGE_EVENT,
} from "./view-state";

/**
 * The liquidity donut as a client island (S4 #520, ADR 0038) so a segment opens
 * its drilldown INSTANTLY — even though the donut lives in a different `<section>`
 * than the composition panel that renders the drill. It cannot share React state
 * across panels, so it coordinates through the URL: a plain click pushes
 * `?drill=…` (preserving the live framing/range/vivienda via the canonical
 * `compositionUrl`), fires the shared `VIEW_STATE_CHANGE_EVENT` the composition
 * island listens to, and scrolls the panel into view. The segments keep their
 * real `<a href>` for the no-JS, deep-link and middle-click paths (§3, §8); the
 * hrefs track the live view-state so a middle-click after a client toggle is
 * still correct.
 */

export interface DonutSegment {
  tier: string;
  drillKey: DrilldownKey;
  /** SVG arc path (`d`). */
  path: string;
  ariaLabel: string;
  title: string;
}

export interface DonutGeometry {
  cx: number;
  cy: number;
  innerRadius: number;
  outerRadius: number;
}

export default function DonutDrill({
  geometry,
  initialHousingMode,
  initialRange,
  initialView,
  segments,
}: {
  geometry: DonutGeometry;
  initialHousingMode: CompositionHousingMode;
  initialRange: CompositionRange;
  initialView: NetWorthFraming;
  segments: readonly DonutSegment[];
}) {
  const [view, setView] = useState<NetWorthFraming>(initialView);
  const [range, setRange] = useState<CompositionRange>(initialRange);
  const [housingMode, setHousingMode] =
    useState<CompositionHousingMode>(initialHousingMode);
  const readRangeFromUrl = useCallback((): CompositionRange => {
    const params = new URLSearchParams(window.location.search);
    return params.has(RANGE_VIEW_PARAM.key)
      ? readViewParam(window.location.search, RANGE_VIEW_PARAM)
      : initialRange;
  }, [initialRange]);

  // Track the live view-state so the fallback hrefs stay correct after a sibling
  // island toggles framing/range/vivienda (pushState fires no native event).
  useEffect(() => {
    const syncFromUrl = () => {
      const search = window.location.search;
      setView(readViewParam(search, FRAMING_VIEW_PARAM));
      setRange(readRangeFromUrl());
      setHousingMode(
        new URLSearchParams(search).get("vivienda") === "oculta" ? "hidden" : "net",
      );
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) syncFromUrl();
    };
    window.addEventListener("popstate", syncFromUrl);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener(VIEW_STATE_CHANGE_EVENT, syncFromUrl);
    return () => {
      window.removeEventListener("popstate", syncFromUrl);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener(VIEW_STATE_CHANGE_EVENT, syncFromUrl);
    };
  }, [readRangeFromUrl]);

  const openDrill = (key: DrilldownKey) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return; // modified click → let the href navigate
    }
    event.preventDefault();
    const liveView = readViewParam(window.location.search, FRAMING_VIEW_PARAM);
    const liveRange = readRangeFromUrl();
    const liveHousing: CompositionHousingMode =
      new URLSearchParams(window.location.search).get("vivienda") === "oculta"
        ? "hidden"
        : "net";
    const href = compositionUrl(liveView, key, liveRange, liveHousing, false);
    window.history.pushState(null, "", `${href}#composicion`);
    window.dispatchEvent(new Event(VIEW_STATE_CHANGE_EVENT));
    // The drill renders in the composition panel below; bring it into view.
    document
      .getElementById("composicion")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <svg
      className="tierDonut"
      viewBox="0 0 100 100"
      role="img"
      aria-label="Distribución por capa de liquidez"
    >
      <circle
        className="donutTrack"
        cx={geometry.cx}
        cy={geometry.cy}
        r={(geometry.outerRadius + geometry.innerRadius) / 2}
        strokeWidth={geometry.outerRadius - geometry.innerRadius}
      />
      {segments.map((segment) => (
        <a
          aria-label={segment.ariaLabel}
          href={compositionUrl(view, segment.drillKey, range, housingMode)}
          key={segment.tier}
          onClick={openDrill(segment.drillKey)}
        >
          <path className={`donutSegment ${segment.tier}`} d={segment.path}>
            <title>{segment.title}</title>
          </path>
        </a>
      ))}
    </svg>
  );
}
