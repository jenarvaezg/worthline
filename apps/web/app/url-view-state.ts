"use client";

import { type MouseEvent, useCallback, useEffect, useState } from "react";

import {
  isPlainAnchorClick,
  readViewParam,
  VIEW_STATE_CHANGE_EVENT,
  type ViewParamSpec,
  writeViewParam,
} from "./view-state";

/**
 * Client wiring for URL-mirrored view state (#746, ADR 0036 / interaction-patterns §3).
 *
 * The pure read/write lives in `view-state.ts`; this module holds the thin
 * `pushState` / `popstate` / sibling-notification shell shared by framing,
 * exposure lens, movers, composition, and donut islands — the same split as
 * `composition-chart-hover.ts` (§7).
 */

/**
 * Mirror a URL change to `history` and nudge sibling islands. `pushState` fires
 * no native event, so every island that mirrors to the URL dispatches
 * `VIEW_STATE_CHANGE_EVENT` after writing.
 */
export function pushMirroredUrl(url: string): void {
  window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(VIEW_STATE_CHANGE_EVENT));
}

/**
 * Subscribe to Back/Forward (`popstate`), bfcache restore (`pageshow.persisted`),
 * and sibling-island URL writes (`VIEW_STATE_CHANGE_EVENT`). Each island passes
 * a callback that re-reads its slice from `window.location`.
 */
export function useViewStateSync(syncFromUrl: () => void): void {
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        syncFromUrl();
      }
    };
    window.addEventListener("popstate", syncFromUrl);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener(VIEW_STATE_CHANGE_EVENT, syncFromUrl);
    return () => {
      window.removeEventListener("popstate", syncFromUrl);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener(VIEW_STATE_CHANGE_EVENT, syncFromUrl);
    };
  }, [syncFromUrl]);
}

/**
 * One typed query param mirrored to the URL: read on load/share, write on toggle
 * without document navigation. Returns `[value, push, onAnchorClick]` for tab
 * islands that keep real `<a href>` fallbacks (§2, §3, §8).
 */
export function useUrlViewParam<T extends string>(
  spec: ViewParamSpec<T>,
  initial: T,
): readonly [
  T,
  (next: T) => void,
  (next: T) => (event: MouseEvent<HTMLAnchorElement>) => void,
] {
  const [value, setValue] = useState<T>(initial);

  const readFromUrl = useCallback(
    () => readViewParam(window.location.search, spec),
    [spec],
  );

  const syncFromUrl = useCallback(() => {
    setValue(readFromUrl());
  }, [readFromUrl]);

  useViewStateSync(syncFromUrl);

  const push = useCallback(
    (next: T) => {
      if (next === readFromUrl()) {
        return;
      }
      const nextSearch = writeViewParam(window.location.search, spec, next);
      pushMirroredUrl(`${window.location.pathname}${nextSearch}${window.location.hash}`);
      setValue(next);
    },
    [spec, readFromUrl],
  );

  const onAnchorClick = useCallback(
    (next: T) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainAnchorClick(event)) {
        return;
      }
      event.preventDefault();
      push(next);
    },
    [push],
  );

  return [value, push, onAnchorClick] as const;
}
