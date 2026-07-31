"use client";

/**
 * FormSubmitScrollKeeper — thin client shell that wires the pure restoration
 * logic (`form-submit-scroll.ts`) to real submits and route changes (#1296).
 *
 * All the judgement lives in the pure module; this file only reads the DOM,
 * writes the scroll, and owns the frame loop. See that module's header for why
 * the restoration is a bounded loop rather than a single frame.
 */

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import {
  canHoldOffset,
  decideRestoreStep,
  isEditableTarget,
  isStaleRecord,
  isUserScrollKey,
  parseSavedScroll,
  type SavedScroll,
  shouldSaveScroll,
} from "./form-submit-scroll";

const KEY = "worthline:form-submit-scroll";

/**
 * Pointer gestures that mean the person took the scroll into their own hands.
 *
 * Deliberately NOT `focusin`. The app moving focus also scrolls (the success
 * panel focuses its heading, `anadir/success-panel.tsx`), but treating that as
 * an interruption would let a stray re-focus during the error navigation abort
 * the very restoration this island exists for. That case needs no special
 * handling anyway: the success panel replaces the form with something shorter,
 * so the geometry guard in `decideRestoreStep` never writes and the window
 * simply closes.
 */
const INTERRUPT_EVENTS = ["wheel", "touchmove"] as const;

function readSavedScroll(): SavedScroll | null {
  try {
    return parseSavedScroll(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

function saveScroll(scroll: SavedScroll) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(scroll));
  } catch {
    // Scroll restoration is best-effort.
  }
}

function removeSavedScroll() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Scroll restoration is best-effort.
  }
}

export default function FormSubmitScrollKeeper() {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    const onSubmit = (event: SubmitEvent) => {
      if (!(event.target instanceof HTMLFormElement)) return;
      if (
        !shouldSaveScroll({
          method: event.target.method,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        })
      ) {
        return;
      }

      saveScroll({
        pathname: window.location.pathname,
        x: window.scrollX,
        y: window.scrollY,
        savedAt: Date.now(),
      });
    };

    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  // `search` is a deliberate re-run trigger, not a value the effect reads (#1275).
  // Mutations routinely land back on the SAME pathname with a different query
  // (?ok=…, ?error=…, filters, ?anchor=…); with only `pathname` in the list the
  // effect would not re-run and the saved scroll would never be restored — the
  // whole point of this island. Biome's fix is tagged unsafe (so `check --write`
  // leaves it alone), but applying it by hand would delete that behaviour.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `search` is an intentional re-run trigger (see the comment above); dropping it breaks scroll restoration on same-pathname, query-only navigations.
  useEffect(() => {
    const saved = readSavedScroll();
    if (!saved) return;
    if (
      saved.pathname !== window.location.pathname ||
      isStaleRecord({ savedAt: saved.savedAt, now: Date.now() })
    ) {
      // The submit led somewhere else, or this record outlived its navigation.
      // Drop it rather than let it sit in sessionStorage and hijack the scroll
      // when this pathname comes back.
      removeSavedScroll();
      return;
    }

    // The record is NOT dropped here. The old implementation deleted it before
    // applying it, so a restoration that landed mid-swap — while the document
    // was still too short to hold the offset — was clamped away with nothing
    // left to retry from (#1296). It is dropped when the loop ends, below.
    const startedAt = performance.now();
    let interrupted = false;
    let frame = 0;
    /** When the offset first became reachable — the re-assert window's clock. */
    let reachableAt: number | null = null;

    const onInterrupt = () => {
      interrupted = true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const element = target instanceof HTMLElement ? target : null;
      if (
        isUserScrollKey({
          key: event.key,
          targetIsEditable: isEditableTarget({
            tagName: element?.tagName ?? null,
            isContentEditable: element?.isContentEditable ?? false,
          }),
        })
      ) {
        interrupted = true;
      }
    };
    for (const type of INTERRUPT_EVENTS) {
      window.addEventListener(type, onInterrupt, { passive: true });
    }
    window.addEventListener("keydown", onKeyDown, { passive: true });

    const stop = () => {
      cancelAnimationFrame(frame);
      for (const type of INTERRUPT_EVENTS) {
        window.removeEventListener(type, onInterrupt);
      }
      window.removeEventListener("keydown", onKeyDown);
    };

    const tick = () => {
      const now = performance.now();
      const geometry = {
        scrollY: window.scrollY,
        maxScrollY:
          document.documentElement.scrollHeight - document.documentElement.clientHeight,
      };
      if (reachableAt === null && canHoldOffset({ target: saved, geometry })) {
        reachableAt = now;
      }

      const step = decideRestoreStep({
        target: saved,
        geometry,
        elapsedMs: now - startedAt,
        reachableElapsedMs: reachableAt === null ? null : now - reachableAt,
        interrupted,
      });

      if (step.action === "stop") {
        removeSavedScroll();
        stop();
        return;
      }
      if (step.action === "apply") {
        window.scrollTo(step.x, step.y);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    // Only tear down the loop — the record stays. React invokes effects twice
    // on mount under Strict Mode (dev), so a cleanup that also dropped the
    // record would consume it before the second run could restore anything.
    // The record is dropped by the loop itself, or by the pathname/staleness
    // guard on the next navigation.
    return stop;
  }, [pathname, search]);

  return null;
}
