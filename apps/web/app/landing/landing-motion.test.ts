import { describe, expect, test } from "vitest";

import {
  COVER_COMPOSITION_DELAY_MS,
  COVER_COUNTER_DELAY_MS,
  COVER_COUNTER_DURATION_MS,
  coverStageDelay,
  formatLandingNet,
  hasAuthenticatedSession,
  nextTypedCharacterCount,
  transitionLandingMotion,
} from "./landing-motion";

describe("landing experience choreography (#953)", () => {
  test("starts the cover promptly and keeps its reveal readable", () => {
    expect(Array.from({ length: 7 }, (_, stage) => coverStageDelay(stage))).toEqual([
      40, 120, 200, 280, 360, 440, 520,
    ]);
    expect(COVER_COUNTER_DELAY_MS).toBe(420);
    expect(COVER_COUNTER_DURATION_MS).toBe(520);
    expect(COVER_COMPOSITION_DELAY_MS).toBe(260);
  });

  test("formats every counter frame in the final es-ES register", () => {
    expect(formatLandingNet(0)).toBe("0 €");
    expect(formatLandingNet(251_527)).toBe("251.527 €");
  });

  test("types deterministically and never overruns the semantic answer", () => {
    expect([0, 1, 2, 72].map((at) => nextTypedCharacterCount(at, 72))).toEqual([
      1, 2, 3, 72,
    ]);
  });

  test("only an Auth.js session with a user is logged in", () => {
    expect(hasAuthenticatedSession(null)).toBe(false);
    expect(hasAuthenticatedSession({})).toBe(false);
    expect(hasAuthenticatedSession({ user: null })).toBe(false);
    expect(hasAuthenticatedSession({ user: { name: "Jose" } })).toBe(true);
  });

  test("starts on mount, settles reduced motion, and never replays a read page", () => {
    expect(
      transitionLandingMotion("pending", {
        type: "ready",
        reducedMotion: false,
      }),
    ).toBe("playing");
    expect(
      transitionLandingMotion("pending", {
        type: "ready",
        reducedMotion: true,
      }),
    ).toBe("final");
    expect(
      transitionLandingMotion("playing", {
        type: "preference-changed",
        reducedMotion: true,
      }),
    ).toBe("final");
    expect(
      transitionLandingMotion("final", {
        type: "preference-changed",
        reducedMotion: false,
      }),
    ).toBe("final");
  });
});
