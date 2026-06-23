"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import type { NetWorthFraming } from "@worthline/domain";

import {
  FRAMING_VIEW_PARAM,
  readViewParam,
  VIEW_STATE_CHANGE_EVENT,
  writeViewParam,
} from "./view-state";

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
  const [view, setView] = useState<NetWorthFraming>(initialView);

  // Re-read the framing the URL carries on Back/Forward (popstate) and on a
  // bfcache restore (pageshow with `persisted`) — neither re-runs SSR, so the
  // island reconciles with the URL itself. Both call setState from an event
  // callback (not synchronously in the effect body), the supported pattern.
  useEffect(() => {
    const syncFromUrl = () =>
      setView(readViewParam(window.location.search, FRAMING_VIEW_PARAM));
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        syncFromUrl();
      }
    };
    window.addEventListener("popstate", syncFromUrl);
    window.addEventListener("pageshow", onPageShow);
    // A sibling island (e.g. the range island, #519) may push a URL change that
    // does not touch `view`; re-reading on its nudge is a no-op then, but keeps
    // this island reconciled if a future island ever writes `view` too.
    window.addEventListener(VIEW_STATE_CHANGE_EVENT, syncFromUrl);
    return () => {
      window.removeEventListener("popstate", syncFromUrl);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener(VIEW_STATE_CHANGE_EVENT, syncFromUrl);
    };
  }, []);

  // Keep the page's other view-bearing server links in sync with the live framing.
  useEffect(() => {
    syncSiblingViewLinks(view);
  }, [view]);

  const select = (next: NetWorthFraming) => (event: MouseEvent<HTMLAnchorElement>) => {
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
    if (next === readViewParam(window.location.search, FRAMING_VIEW_PARAM)) {
      return;
    }
    const nextSearch = writeViewParam(window.location.search, FRAMING_VIEW_PARAM, next);
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${nextSearch}${window.location.hash}`,
    );
    setView(next);
    // Nudge sibling islands (e.g. the range island) to re-read `view` from the
    // URL — `pushState` fires no event they could otherwise observe (§3).
    window.dispatchEvent(new Event(VIEW_STATE_CHANGE_EVENT));
  };

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
