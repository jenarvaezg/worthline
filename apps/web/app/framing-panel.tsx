"use client";

import type { NetWorthFraming } from "@worthline/domain";
import { type ReactNode, useEffect } from "react";

import { useUrlViewParam } from "./url-view-state";
import { FRAMING_VIEW_PARAM, writeViewParam } from "./view-state";

/**
 * The Vista framing toggle as a client island (#518, ADR 0036, Phase 0 S2).
 *
 * The server sends BOTH framings' hero content (`total` / `liquid`) plus the
 * tabs' real `href`s; this island shows the active one and switches instantly on
 * click — no server round-trip (the S0 baseline measured that round-trip at
 * ~2.3s). Progressive enhancement (interaction-patterns §2/§3): the tabs stay
 * real `<a href>` links, so they deep-link, are keyboard-operable, and work with
 * JS off; the island only *intercepts* a plain left-click to swap client-side
 * and mirror `view` to the URL via `history.pushState`. Back/Forward re-read the
 * framing from the URL via `popstate`, so shareable URLs and history keep working.
 *
 * The toggle logic is the pure `view-state` module; this component is the thin
 * pushState/popstate shell (the established `composition-chart-hover` split).
 */

export interface FramingTab {
  id: NetWorthFraming;
  label: string;
  /** Server-built URL for this framing — the no-JS fallback and the deep-link. */
  href: string;
}

/**
 * Rewrite the `view` param of the page's OTHER same-page view-bearing links (the
 * donut drill segments, the range pills, the vivienda toggle) so a later server
 * navigation keeps the client-toggled framing (interaction-patterns §3). They
 * are plain server-rendered `<a>` (a full-document nav reads the DOM `href`) and
 * stay pinned to the request-time view until S3/S4 clientify those surfaces —
 * this is the transitional bridge. The framing tabs own their per-view hrefs, so
 * they are excluded; cross-page links (different pathname) never carry view.
 */
function syncSiblingViewLinks(view: NetWorthFraming): void {
  const grid = document.querySelector(".dashGrid");
  if (!grid) {
    return;
  }
  for (const anchor of grid.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (anchor.closest(".framingTabs")) {
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
    anchor.setAttribute(
      "href",
      `${url.pathname}${writeViewParam(url.search, FRAMING_VIEW_PARAM, view)}${url.hash}`,
    );
  }
}

export default function FramingPanel({
  initialView,
  tabs,
  total,
  liquid,
}: {
  initialView: NetWorthFraming;
  tabs: readonly FramingTab[];
  total: ReactNode;
  liquid: ReactNode;
}) {
  const [view, , select] = useUrlViewParam(FRAMING_VIEW_PARAM, initialView);

  // Keep the page's other view-bearing server links in sync with the live framing.
  useEffect(() => {
    syncSiblingViewLinks(view);
  }, [view]);

  const activeLabel = tabs.find((tab) => tab.id === view)?.label ?? "";

  return (
    <>
      <div className="resumenHeader">
        <nav className="framingTabs" aria-label="Vista de patrimonio">
          {tabs.map((tab) => {
            const isActive = tab.id === view;
            return (
              <a
                aria-current={isActive ? "true" : undefined}
                className={isActive ? "active" : undefined}
                href={tab.href}
                key={tab.id}
                onClick={select(tab.id)}
              >
                {tab.label}
              </a>
            );
          })}
        </nav>
      </div>
      {/* Announce the framing change for screen readers — a client toggle is not
          a document navigation, so it is not announced otherwise (§8). */}
      <p aria-live="polite" className="srOnly">{`Vista: ${activeLabel}`}</p>
      {view === "total" ? total : liquid}
    </>
  );
}
