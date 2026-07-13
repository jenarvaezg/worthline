/**
 * Landing capture + launch-budget probe (PRD #877 S6, #954).
 *
 * Captures the public landing at the two reference widths — 1440 (desktop) and
 * 390 (mobile) — as full-page PNGs, and reports the one-shot launch budget the
 * estreno gates on: transferred weight (< 500 KB), LCP (< 1.5 s) and CLS (< 0.1).
 * Lighthouse mobile ≥ 95 stays a manual check — run Lighthouse against the same
 * URL; this probe covers the numeric budgets it can measure headless.
 *
 * Point it at a PRODUCTION server for a meaningful weight/LCP probe (a dev
 * server ships unminified bundles and HMR, so its weight is not representative):
 *
 *   bun run build
 *   bun run --filter @worthline/web start   # serves the built app on :3000
 *   CAPTURE_URL=http://localhost:3000 bun run capture:landing
 *
 * PNGs land in `artifacts/landing/` (override with CAPTURE_OUT). The process
 * exits non-zero if any width blows the budget, so it can gate a launch check.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { type Browser, chromium } from "@playwright/test";

const BASE_URL = process.env.CAPTURE_URL ?? "http://localhost:3000";
const OUT_DIR = process.env.CAPTURE_OUT ?? join(process.cwd(), "artifacts", "landing");
const LANDING_PATH = "/";

const VIEWPORTS = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

/** The estreno launch budget (#954). */
const BUDGET = { weightKb: 500, lcpMs: 1500, cls: 0.1 };

interface Vitals {
  lcpMs: number;
  cls: number;
}

interface Shot {
  name: string;
  file: string;
  weightKb: number;
  vitals: Vitals;
  ok: boolean;
}

async function captureViewport(
  browser: Browser,
  vp: (typeof VIEWPORTS)[number],
): Promise<Shot> {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  await page.goto(new URL(LANDING_PATH, BASE_URL).toString(), {
    waitUntil: "networkidle",
  });

  // Wire weight = sum of transferSize (compressed body + headers) across the
  // navigation and every resource, read straight from the Resource Timing API.
  const weightBytes = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation") as PerformanceResourceTiming[];
    const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    return [...nav, ...res].reduce((acc, entry) => acc + (entry.transferSize || 0), 0);
  });

  const vitals = await page.evaluate(
    () =>
      new Promise<Vitals>((resolve) => {
        let lcpMs = 0;
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            lcpMs = entry.startTime;
          }
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as Array<
            PerformanceEntry & { value: number; hadRecentInput: boolean }
          >) {
            if (!entry.hadRecentInput) cls += entry.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(
          () => resolve({ lcpMs: Math.round(lcpMs), cls: Number(cls.toFixed(4)) }),
          1500,
        );
      }),
  );

  const file = join(OUT_DIR, `landing-${vp.name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();

  const weightKb = Math.round(weightBytes / 1024);
  const ok =
    weightKb <= BUDGET.weightKb &&
    vitals.lcpMs <= BUDGET.lcpMs &&
    vitals.cls <= BUDGET.cls;

  return { name: vp.name, file, weightKb, vitals, ok };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const shots: Shot[] = [];
  try {
    for (const vp of VIEWPORTS) {
      shots.push(await captureViewport(browser, vp));
    }
  } finally {
    await browser.close();
  }

  console.log(`\nLanding launch budget — ${BASE_URL}${LANDING_PATH}`);
  console.log(
    `Budget: weight ≤ ${BUDGET.weightKb} KB · LCP ≤ ${BUDGET.lcpMs} ms · CLS ≤ ${BUDGET.cls}\n`,
  );
  for (const shot of shots) {
    const flag = shot.ok ? "PASS" : "FAIL";
    console.log(
      `[${flag}] ${shot.name.padEnd(13)} weight ${String(shot.weightKb).padStart(4)} KB · LCP ${String(shot.vitals.lcpMs).padStart(5)} ms · CLS ${shot.vitals.cls}`,
    );
    console.log(`         → ${shot.file}`);
  }
  console.log("\nManual: run Lighthouse (mobile) against the same URL — target ≥ 95.\n");

  if (shots.some((shot) => !shot.ok)) {
    process.exitCode = 1;
  }
}

void main();
