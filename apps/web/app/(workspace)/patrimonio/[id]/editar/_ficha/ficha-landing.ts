/**
 * Where a registration from the side panel lands (#1829): the island's wiring of
 * the rules in `ficha-again.ts`.
 *
 * A submit from the panel keeps its terminal untouched — success redirects, a
 * refusal comes back in place (#1311, interaction-patterns §4.1); nothing here
 * pushes a URL while it is in flight — but the island remembers what left, so when
 * the URL lands on that submit's success it brings the result into view: the row
 * the render added, the notice beside the tabs, and focus on «Añadir otra». Its own
 * module since the #1731 review, so `holding-ficha.tsx` keeps the view and the
 * panel, and this keeps the landing.
 */

import { SEED_CHOICE_ATTRIBUTE } from "@web/_components/form-seed-names";
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  againFor,
  type LandedSubmission,
  landedOk,
  type PanelSubmission,
  panelSubmission,
  stillLanded,
} from "./ficha-again";

export interface FichaLanding {
  /** The action whose «Añadir otra» the notice offers now, or null. */
  againKey: string | null;
  /** The notice's «Añadir otra», where focus goes on landing. */
  againRef: RefObject<HTMLButtonElement | null>;
  /** Abandon what the panel sent and has not landed: it was closed by hand. */
  forget: () => void;
  /** The panel submit whose success the URL reports, while it does. */
  landed: LandedSubmission | null;
  /** The success notice beside the tabs. */
  noticeRef: RefObject<HTMLDivElement | null>;
  /** The ficha root's submit capture: remembers what leaves the panel. */
  onSubmitCapture: (event: FormEvent<HTMLDivElement>) => void;
}

export function useFichaLanding({
  ok,
  openAction,
  panelRef,
  rootRef,
  searchKey,
}: {
  /** The success the URL reports (`?ok=`). */
  ok: string | null;
  /** The action whose panel is open, or null. */
  openAction: string | null;
  panelRef: RefObject<HTMLElement | null>;
  rootRef: RefObject<HTMLElement | null>;
  /** The query string, to notice the URL moving. */
  searchKey: string;
}): FichaLanding {
  const noticeRef = useRef<HTMLDivElement>(null);
  const againRef = useRef<HTMLButtonElement>(null);
  // The panel submit still waiting for its terminal, and the one that landed.
  const pending = useRef<PanelSubmission | null>(null);
  const [landed, setLanded] = useState<LandedSubmission | null>(null);

  const forget = useCallback(() => {
    pending.current = null;
  }, []);

  // What leaves the panel is remembered — which action, where its terminal returns,
  // its date and currency — and nothing else is touched: the form's own handler
  // still runs its action and keeps its terminal. A submit from anywhere else on
  // the ficha (a delete in the ledger, «Lo básico») forgets it.
  function onSubmitCapture(event: FormEvent<HTMLDivElement>) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (openAction === null || !panelRef.current?.contains(form)) {
      pending.current = null;
      // The person moved on: this submit's own success is not the panel's.
      setLanded(null);
      return;
    }
    const choice = form
      .closest(`[${SEED_CHOICE_ATTRIBUTE}]`)
      ?.getAttribute(SEED_CHOICE_ATTRIBUTE);
    pending.current = panelSubmission(openAction, new FormData(form), choice);
  }

  // The URL moved: if it is the success of what the panel sent, that submit landed;
  // otherwise whatever had landed lasts only while the URL still reports it.
  useEffect(() => {
    const submitted = pending.current;
    const landedWith = submitted
      ? landedOk(submitted, { pathname: window.location.pathname, search: searchKey })
      : null;
    if (submitted !== null && landedWith !== null) {
      pending.current = null;
      setLanded({ ok: landedWith, submission: submitted });
      return;
    }
    setLanded((previous) =>
      stillLanded(previous, new URLSearchParams(searchKey).get("ok")),
    );
  }, [searchKey]);

  // It landed: bring the result into view — the row the render added, then the
  // notice — and put focus where the next step is, «Añadir otra». When both fit,
  // the usual case, both are on screen. When they do not (a long Cobros tab), the
  // notice wins: focus goes to its offer, and focus never lands on something the
  // view left (§8) — the row stays marked for whoever scrolls to it. The page's
  // scroll keeper leaves this terminal alone (`data-own-landing`).
  useEffect(() => {
    if (landed === null) return;
    const band = noticeRef.current;
    // The last one: a recurring cobro's first occurrence in the grid can be new
    // too, and what was added is the declaration listed below it.
    const marked = rootRef.current?.querySelectorAll("[data-fresh]") ?? [];
    marked[marked.length - 1]?.scrollIntoView({ block: "nearest" });
    band?.scrollIntoView({ block: "nearest" });
    (againRef.current ?? band)?.focus({ preventScroll: true });
  }, [landed, rootRef]);

  return {
    // Offered while the URL still reports the success that landed, and with no
    // panel open over it (`againFor`).
    againKey: againFor(landed, { ok, panelOpen: openAction !== null }),
    againRef,
    forget,
    landed,
    noticeRef,
    onSubmitCapture,
  };
}
