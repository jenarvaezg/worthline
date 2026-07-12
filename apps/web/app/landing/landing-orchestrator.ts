import {
  COVER_COMPOSITION_DELAY_MS,
  COVER_COUNTER_DELAY_MS,
  COVER_COUNTER_DURATION_MS,
  coverStageDelay,
  formatLandingNet,
  type LandingMotionState,
  nextTypedCharacterCount,
  transitionLandingMotion,
} from "./landing-motion";

interface LandingOrchestrationOptions {
  netFinal: string;
  netTarget: number;
}

function select<ElementType extends Element>(root: ParentNode, selector: string) {
  return root.querySelector<ElementType>(selector);
}

function cloneTextPrefix(source: ParentNode, remaining: { value: number }) {
  const fragment = document.createDocumentFragment();

  for (const node of source.childNodes) {
    if (remaining.value <= 0) break;

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      const prefix = text.slice(0, remaining.value);
      if (prefix) fragment.appendChild(document.createTextNode(prefix));
      remaining.value -= prefix.length;
      continue;
    }

    if (node instanceof Element) {
      const countBeforeNode = remaining.value;
      const clone = node.cloneNode(false) as Element;
      clone.appendChild(cloneTextPrefix(node, remaining));
      if (remaining.value < countBeforeNode) fragment.appendChild(clone);
    }
  }

  return fragment;
}

/**
 * Orchestrates the server-rendered landing DOM and returns a complete cleanup.
 * React owns only the masthead island; this module owns every progressive
 * class/text mutation outside it.
 */
export function startLandingOrchestration({
  netFinal,
  netTarget,
}: LandingOrchestrationOptions): () => void {
  const root = document.querySelector<HTMLElement>("[data-landing-root]");
  if (!root) return () => {};

  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stages = Array.from(root.querySelectorAll<HTMLElement>("[data-cover-stage]"));
  const seats = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal-seat]"));
  const net = select<HTMLElement>(root, "[data-net-figure]");
  const netRule = select<HTMLElement>(root, "[data-net-rule]");
  const spark = select<HTMLElement>(root, "[data-net-spark]");
  const composition = select<HTMLElement>(root, "[data-comp-bar]");
  const pen = select<HTMLElement>(root, "[data-pen-circle]");
  const penNote = select<HTMLElement>(root, "[data-pen-note]");
  const chatVisual = select<HTMLElement>(root, "[data-chat-visual]");
  const chatFoot = select<HTMLElement>(root, "[data-chat-foot]");
  const chatTemplate = chatVisual?.cloneNode(true) as HTMLElement | undefined;
  const chatCharacterCount = chatTemplate?.textContent?.length ?? 0;

  let motionState: LandingMotionState = "pending";
  let listenerRegistered = false;
  let observer: IntersectionObserver | undefined;
  let frame: number | undefined;
  let chatTimer: number | undefined;
  const timers = new Set<number>();

  const later = (callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  };

  const clearMotionRuntime = () => {
    for (const timer of timers) window.clearTimeout(timer);
    timers.clear();
    if (chatTimer !== undefined) window.clearInterval(chatTimer);
    chatTimer = undefined;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    observer?.disconnect();
    observer = undefined;
  };

  const renderChatProgress = (characterCount: number, showCaret: boolean) => {
    if (!chatVisual || !chatTemplate) return;
    chatVisual.replaceChildren(cloneTextPrefix(chatTemplate, { value: characterCount }));
    if (!showCaret) return;
    const caret = document.createElement("span");
    caret.dataset.chatCaret = "";
    chatVisual.appendChild(caret);
  };

  const finishChat = () => {
    if (chatTimer !== undefined) window.clearInterval(chatTimer);
    chatTimer = undefined;
    renderChatProgress(chatCharacterCount, false);
    chatFoot?.classList.add("on");
  };

  const revealSeat = (seat: HTMLElement, animateChat = true) => {
    seat.classList.add("seen");
    for (const item of seat.querySelectorAll<HTMLElement>("[data-reveal]")) {
      item.classList.add("seen");
    }
    for (const drawing of seat.querySelectorAll<HTMLElement>("[data-draw]")) {
      drawing.classList.add("on");
    }
    if (seat.querySelector("[data-ref-text]")) {
      pen?.classList.add("on");
      penNote?.classList.add("on");
    }
    if (
      animateChat &&
      seat.querySelector("[data-chat-visual]") &&
      chatVisual &&
      chatTimer === undefined
    ) {
      renderChatProgress(0, true);
      let characterCount = 0;
      chatTimer = window.setInterval(() => {
        characterCount = nextTypedCharacterCount(characterCount, chatCharacterCount);
        if (characterCount >= chatCharacterCount) {
          finishChat();
          return;
        }
        renderChatProgress(characterCount, true);
      }, 18);
    }
  };

  const showFinalState = () => {
    clearMotionRuntime();
    root.dataset.motion = "off";
    if (net) net.textContent = netFinal;
    for (const stage of stages) stage.classList.add("on");
    for (const seat of seats) revealSeat(seat, false);
    netRule?.classList.add("on");
    spark?.classList.add("on");
    composition?.classList.add("on");
    pen?.classList.add("on");
    penNote?.classList.add("on");
    finishChat();
  };

  const playMotion = () => {
    clearMotionRuntime();
    root.dataset.motion = "on";
    for (const stage of stages) stage.classList.remove("on");
    for (const seat of seats) {
      seat.classList.remove("seen");
      for (const item of seat.querySelectorAll<HTMLElement>("[data-reveal]")) {
        item.classList.remove("seen");
      }
      for (const drawing of seat.querySelectorAll<HTMLElement>("[data-draw]")) {
        drawing.classList.remove("on");
      }
    }
    netRule?.classList.remove("on");
    spark?.classList.remove("on");
    composition?.classList.remove("on");
    pen?.classList.remove("on");
    penNote?.classList.remove("on");
    chatFoot?.classList.remove("on");
    if (net) net.textContent = formatLandingNet(0);

    for (const stage of stages) {
      later(
        () => stage.classList.add("on"),
        coverStageDelay(Number(stage.dataset.coverStage)),
      );
    }

    later(() => {
      const startedAt = performance.now();
      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / COVER_COUNTER_DURATION_MS);
        const eased = 1 - (1 - progress) ** 3;
        if (net) net.textContent = formatLandingNet(Math.round(netTarget * eased));
        if (progress < 1) {
          frame = window.requestAnimationFrame(tick);
        } else {
          frame = undefined;
          if (net) net.textContent = netFinal;
          netRule?.classList.add("on");
        }
      };
      frame = window.requestAnimationFrame(tick);
      spark?.classList.add("on");
      later(() => composition?.classList.add("on"), COVER_COMPOSITION_DELAY_MS);
    }, COVER_COUNTER_DELAY_MS);

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const seat = entry.target as HTMLElement;
          revealSeat(seat);
          observer?.unobserve(seat);
        }
      },
      { threshold: 0.25 },
    );
    for (const seat of seats) observer.observe(seat);
  };

  const enterMotionState = (next: LandingMotionState) => {
    if (next === motionState) return;
    motionState = next;
    if (next === "playing") playMotion();
    if (next === "final") showFinalState();
  };

  const handlePreferenceChange = () => {
    enterMotionState(
      transitionLandingMotion(motionState, {
        type: "preference-changed",
        reducedMotion: media.matches,
      }),
    );
  };

  enterMotionState(
    transitionLandingMotion(motionState, {
      type: "ready",
      reducedMotion: media.matches,
    }),
  );
  media.addEventListener("change", handlePreferenceChange);
  listenerRegistered = true;

  return () => {
    if (listenerRegistered) media.removeEventListener("change", handlePreferenceChange);
    clearMotionRuntime();
    root.dataset.motion = "off";
    finishChat();
  };
}
