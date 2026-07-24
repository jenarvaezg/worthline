"use client";

import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  isAssistantSurface,
  isOnboardingSurface,
  ONBOARDING_RERUN_PARAM,
} from "./screen-context";

/**
 * Lazy boundary for the floating assistant (#1192, perf umbrella #1189).
 *
 * The heavy `AssistantLayer` — AI SDK `useChat`, streaming markdown, the proposal
 * cards and their server actions, the attachment extractors — used to be imported
 * statically from the root layout, so all that JS entered the initial bundle and
 * the hydration of every workspace page even with the panel closed. It was the
 * app's single biggest chunk of eager client JS.
 *
 * This launcher is the small piece that stays eager: it renders only the FAB and
 * the surface gate. The layer chunk is `next/dynamic`-imported and does not load
 * until the panel is actually opened — either by clicking the FAB or via the
 * `?repasar=1` deep-link that re-launches onboarding from the ordinary panel
 * (#1170). The first open pays a one-off, brief chunk load (no visible placeholder
 * beyond the FAB disappearing); once mounted, the layer keeps its own open/close
 * state and its conversation survives in-app navigation exactly as before.
 *
 * `/bienvenida` does NOT go through here: that route imports `AssistantLayer`
 * directly in its `onboarding` variant, so the estreno surface loads eager with
 * no placeholder flash on the first screen post-registro.
 */
const AssistantLayer = dynamic(() => import("./assistant-layer"), {
  ssr: false,
  loading: () => null,
});

export default function AssistantLauncher({
  mutationsDisabled = false,
  mutationsDisabledMessage,
}: {
  mutationsDisabled?: boolean;
  mutationsDisabledMessage: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Sticky: once the layer has been requested we keep it mounted so its
  // conversation persists across navigation (S0 decision #628) — handing over
  // entirely to the layer's own open/close, surface gate and FAB from here on.
  const [activated, setActivated] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);

  // The re-run deep-link (#1170) opens the panel programmatically: activate the
  // layer so its own effect can open it, seed the opening turn, and strip the flag.
  const rerunRequested = searchParams.get(ONBOARDING_RERUN_PARAM) === "1";
  useEffect(() => {
    if (rerunRequested) setActivated(true);
  }, [rerunRequested]);

  if (activated) {
    // Once activated the layer takes over completely — same instance across
    // navigation (root-layout mount), so nothing here re-gates or remounts it.
    return (
      <AssistantLayer
        initialOpen
        mutationsDisabled={mutationsDisabled}
        mutationsDisabledMessage={mutationsDisabledMessage}
      />
    );
  }

  // Pre-activation gate mirrors the floating layer's own: never on the public
  // landing, never on the onboarding route (that surface owns the full-screen
  // variant). The FAB markup matches the layer's so nothing shifts on handover.
  if (!isAssistantSurface(pathname) || isOnboardingSurface(pathname)) {
    return null;
  }

  return (
    <button
      aria-label="Abrir asistente"
      className="assistantFab"
      onClick={() => setActivated(true)}
      ref={fabRef}
      type="button"
    >
      ✳
    </button>
  );
}
