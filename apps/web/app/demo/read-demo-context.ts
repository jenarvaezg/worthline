/**
 * Server adapter for the demo context (PRD #297). Reads the environment and the
 * persona cookie and delegates to the pure {@link resolveDemoContext}. Kept apart
 * from the pure resolver so the resolver stays a `next/headers`-free unit.
 *
 * When `DEMO` is unset it short-circuits BEFORE touching `cookies()`, so the live
 * build never reads a cookie here and its pages keep their existing static/dynamic
 * behavior.
 */
import { cookies } from "next/headers";

import {
  DEMO_PERSONA_COOKIE_NAME,
  resolveDemoContext,
  type DemoContext,
} from "@web/demo/demo-context";

export async function readDemoContext(): Promise<DemoContext> {
  const demoFlag = process.env.DEMO;
  if (!demoFlag) {
    return resolveDemoContext({});
  }

  const jar = await cookies();
  return resolveDemoContext({
    demoFlag,
    demoNow: process.env.WORTHLINE_DEMO_NOW,
    personaCookie: jar.get(DEMO_PERSONA_COOKIE_NAME)?.value,
  });
}
