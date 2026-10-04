/**
 * `captureSnapshotAction` — the local-mode manual capture behind «Capturar hoy».
 *
 * ADR 0037 schedules a twice-daily capture for hosted workspaces, and ADR 0030's
 * local no-auth mode has no control plane to enumerate, so nothing writes a
 * snapshot there: since #895 the render stopped self-healing one, which leaves
 * /historico permanently empty locally. This action is the local stand-in, and it
 * runs the SAME `captureDailySnapshotForWorkspace` the cron runs.
 *
 * Exercised through the real FormData → terminal interface against an in-memory
 * store, the way `refresh-prices-action.test.ts` and `debt-actions.test.ts` do.
 * Pinned along four axes:
 *
 *  - the happy path writes one snapshot per scope (the multi-scope loop, #895),
 *    and re-running replaces the same day rather than duplicating it (ADR 0005
 *    latest-wins — the reason this action sets `datedFact: false`),
 *  - a NON-local target is refused by the action itself, not merely hidden by the
 *    page, so a crafted POST to a hosted deploy writes nothing,
 *  - a refusal has TWO terminals and both say the same thing: returned state when
 *    the submit stamped `inlineError=1` (ADR 0036's #1311 amendment — the one
 *    that cannot be lost to a navigation), and a redirect when it did not, which
 *    is the only terminal a no-JS post can render,
 *  - the demo is stopped earlier still, by the shared `guardDemoWrite` in the
 *    combinator's front matter, before the local check is even reached — and it
 *    redirects either way, since a blocked write must never reach a rendered state.
 *
 * `readStoreTarget` is mocked because the claim is about the action's OWN re-check
 * of an already-resolved target; resolving one for real would drag Auth.js in.
 * The guard reads the same mock, so `guardDemoWrite` is exercised against it too.
 */

import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard";
import type { FormActionState } from "@web/form-action";
import type { StoreTarget } from "@web/store-resolver";
import type { WorthlineStore } from "@worthline/db";
import { createInMemoryStore } from "@worthline/db";
import { type Clock, fixedClock, listScopeOptions } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";

import { captureSnapshotAction } from "./capture-snapshot-action";
import { LOCAL_CAPTURE_ONLY_MESSAGE } from "./local-capture";

let mockTarget: StoreTarget = { kind: "local" };
vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => mockTarget,
}));

afterEach(() => {
  mockTarget = { kind: "local" };
});

/** A workspace the page would never have rendered the button for. */
const HOSTED: StoreTarget = {
  kind: "authenticated",
  dbUrl: "libsql://example.turso.io",
  token: "jwt",
  workspaceId: "ws_1",
};

const CLOCK: Clock = fixedClock("2026-06-18T10:00:00.000Z");
const TODAY = "2026-06-18";

/** A household with two members, so the capture must walk three scopes. */
async function seedHousehold(store: WorthlineStore): Promise<void> {
  await store.workspace.initializeWorkspace({
    members: [
      { id: "member_ana", name: "Ana" },
      { id: "member_jose", name: "Jose" },
    ],
    mode: "household",
  });
  await store.assets.createManualAsset({
    currency: "EUR",
    currentValueMinor: 100_000_00,
    id: "asset_cash",
    liquidityTier: "cash",
    name: "Caja comun",
    ownership: [
      { memberId: "member_ana", shareBps: 6_000 },
      { memberId: "member_jose", shareBps: 4_000 },
    ],
    type: "cash",
  });
}

function form({ inlineError = false } = {}): FormData {
  const fd = new FormData();
  fd.set("currentUrl", "/historico?range=1y");
  // What the control stamps when JS is on. Absent from a real no-JS post, and
  // that difference is the whole point: it picks which terminal can carry a
  // refusal.
  if (inlineError) fd.set("inlineError", "1");
  return fd;
}

/** Drive the action and read back the URL its redirect terminal names. */
async function run(store: WorthlineStore, clock: Clock = CLOCK): Promise<URL> {
  try {
    await captureSnapshotAction(form(), store, clock);
    throw new Error("action did not redirect");
  } catch (err) {
    const e = err as { message?: string; digest?: string };
    // Next's digest is `NEXT_REDIRECT;<type>;<url>;<status>;`, and `<url>` holds
    // no bare `;` — `errorRedirectUrl` percent-encodes them — so the split is safe
    // and reading the params through `URLSearchParams` decodes the message.
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return new URL(e.digest.split(";")[2] ?? "", "http://localhost");
    }
    throw err;
  }
}

/** Drive the action the way the control does, and read back what it hands the form. */
async function runInline(
  store: WorthlineStore,
  clock: Clock = CLOCK,
): Promise<FormActionState> {
  return captureSnapshotAction(form({ inlineError: true }), store, clock);
}

async function snapshotCountPerScope(
  store: WorthlineStore,
): Promise<Record<string, number>> {
  const workspace = await store.workspace.readWorkspace();
  const counts: Record<string, number> = {};
  for (const scope of listScopeOptions(workspace!)) {
    counts[scope.id] = (await store.snapshots.readSnapshots(scope.id)).length;
  }
  return counts;
}

const NOTHING_CAPTURED = { household: 0, member_ana: 0, member_jose: 0 };
const ONE_PER_SCOPE = { household: 1, member_ana: 1, member_jose: 1 };

describe("captureSnapshotAction — local mode manual capture", () => {
  test("captures one snapshot per scope and names the day it stamped", async () => {
    const store = await createInMemoryStore();
    await seedHousehold(store);

    const url = await run(store);

    expect(url.searchParams.get("ok")).toBe("snapshot_captured");
    expect(url.searchParams.get("date")).toBe(TODAY);
    // Back to the page's own URL, range intact — not a bare /historico that would
    // drop the window the user was looking at.
    expect(url.pathname).toBe("/historico");
    expect(url.searchParams.get("range")).toBe("1y");
    expect(await snapshotCountPerScope(store)).toEqual(ONE_PER_SCOPE);
  });

  test("re-running replaces today's point instead of duplicating it (ADR 0005)", async () => {
    const store = await createInMemoryStore();
    await seedHousehold(store);

    await run(store);
    // A second click on the same day, hours later: latest wins, still one row.
    await run(store, fixedClock(`${TODAY}T21:00:00.000Z`));

    expect(await snapshotCountPerScope(store)).toEqual(ONE_PER_SCOPE);
    const household = await store.snapshots.readSnapshots("household");
    expect(household.map((snapshot) => snapshot.capturedAt)).toEqual([
      `${TODAY}T21:00:00.000Z`,
    ]);
  });

  test("refuses a hosted target even when the POST skips the page, writing nothing", async () => {
    const store = await createInMemoryStore();
    await seedHousehold(store);
    mockTarget = HOSTED;

    const url = await run(store);

    expect(url.searchParams.get("error")).toBe(LOCAL_CAPTURE_ONLY_MESSAGE);
    expect(url.searchParams.get("ok")).toBeNull();
    expect(await snapshotCountPerScope(store)).toEqual(NOTHING_CAPTURED);
  });

  test("the same refusal comes back as state to a submit that asked for it inline", async () => {
    const store = await createInMemoryStore();
    await seedHousehold(store);
    mockTarget = HOSTED;

    const state = await runInline(store);

    // Not a redirect: this is the terminal a navigation can lose, which is the
    // whole reason the control stamps `inlineError=1` and hands the reason back
    // in place. Same wording as the URL terminal, so neither can say one thing
    // and the other another.
    expect(state).toEqual({ ok: false, error: LOCAL_CAPTURE_ONLY_MESSAGE });
    expect(await snapshotCountPerScope(store)).toEqual(NOTHING_CAPTURED);
  });

  test("asking for the inline terminal does not touch the success one", async () => {
    const store = await createInMemoryStore();
    await seedHousehold(store);

    // The opt-in only moves REJECTIONS. A success still redirects — it
    // revalidates, so it both needs the fresh destination and carries the
    // recovery net a returned state would throw away.
    try {
      await runInline(store);
      throw new Error("action did not redirect on success");
    } catch (err) {
      const e = err as { message?: string; digest?: string };
      if (e.message !== "NEXT_REDIRECT" || typeof e.digest !== "string") throw err;
      const redirected = new URL(e.digest.split(";")[2] ?? "", "http://localhost");
      expect(redirected.searchParams.get("ok")).toBe("snapshot_captured");
      expect(redirected.searchParams.get("date")).toBe(TODAY);
    }
    expect(await snapshotCountPerScope(store)).toEqual(ONE_PER_SCOPE);
  });

  test("the demo is refused by the shared write guard, before the local check", async () => {
    const store = await createInMemoryStore();
    await seedHousehold(store);
    mockTarget = { kind: "demo", persona: "joven", now: "2026-06-18T10:00:00.000Z" };

    const url = await run(store);

    expect(url.searchParams.get("error")).toBe(DEMO_DISABLED_MESSAGE);
    expect(url.searchParams.get("error")).not.toBe(LOCAL_CAPTURE_ONLY_MESSAGE);
    expect(await snapshotCountPerScope(store)).toEqual(NOTHING_CAPTURED);
  });

  test("the demo redirects even to a submit asking inline — a block is not a message", async () => {
    const store = await createInMemoryStore();
    await seedHousehold(store);
    mockTarget = { kind: "demo", persona: "joven", now: "2026-06-18T10:00:00.000Z" };

    try {
      await runInline(store);
      throw new Error("the write guard did not redirect");
    } catch (err) {
      const e = err as { message?: string; digest?: string };
      expect(e.message).toBe("NEXT_REDIRECT");
    }
    expect(await snapshotCountPerScope(store)).toEqual(NOTHING_CAPTURED);
  });
});
