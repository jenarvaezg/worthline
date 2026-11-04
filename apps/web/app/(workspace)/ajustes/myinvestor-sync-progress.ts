/**
 * What the «Poner al día» panel shows while its press is pending (#1884, design A):
 * the steps of the pass, live, or the wait for a pass that was already running.
 * Pure and client-safe; the panel polls `/api/myinvestor/progress` and asks here.
 */
import { MYINVESTOR_SYNC_STEPS } from "./myinvestor-sync-outcome";

/** The body of `GET /api/myinvestor/progress`. */
export interface MyInvestorProgress {
  running: boolean;
  step: string | null;
  startedAt: string | null;
}

/** How long before the press a pass must have started to be someone else's. */
const OWN_PASS_SLACK_MS = 2_000;

export type MyInvestorProgressView =
  /** This press's pass: the index of the step it is on. */
  | { kind: "steps"; current: number }
  /** A pass that was running before the press: the press waits for it. */
  | { kind: "waiting"; startedAt: string };

/** The pending press, read against the last poll (null before the first answer). */
export function myInvestorProgressView(
  progress: MyInvestorProgress | null,
  pressedAt: number,
): MyInvestorProgressView {
  if (progress?.running && progress.startedAt) {
    const started = Date.parse(progress.startedAt);
    if (started < pressedAt - OWN_PASS_SLACK_MS) {
      return { kind: "waiting", startedAt: progress.startedAt };
    }
  }
  const index = MYINVESTOR_SYNC_STEPS.findIndex((step) => step.key === progress?.step);
  return { current: Math.max(0, index), kind: "steps" };
}

/** Each step's state for the list: done, the one in progress, or still to come. */
export function myInvestorStepStates(
  current: number,
): { key: string; label: string; state: "done" | "now" | "todo" }[] {
  return MYINVESTOR_SYNC_STEPS.map((step, index) => ({
    key: step.key,
    label: step.label,
    state: index < current ? "done" : index === current ? "now" : "todo",
  }));
}
