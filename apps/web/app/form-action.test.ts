/**
 * Choreography tests for the `formAction` / `formActionState` combinator
 * (PRD #1112 S1). These exercise the SHELL the combinator owns — test-seam
 * injection, the demo/impersonation write guard, the missing-id short-circuit,
 * parse-failure surfacing (with preserved fields), the duplicate-date
 * translation, and the success/error terminals — through a trivial config
 * against an injected fake store, independent of any real command.
 */

import { DUPLICATE_DATED_FACT_MESSAGE } from "@web/action-store";
import { DEMO_DISABLED_MESSAGE } from "@web/demo/write-guard";
import { errorRedirectUrl, successRedirectUrl } from "@web/intake";
import type { WorthlineStore } from "@web/store";
import { type Clock, fixedClock } from "@worthline/domain";
import { afterEach, describe, expect, test, vi } from "vitest";
import { formAction, formActionState } from "./form-action";

// Drive demo-ness through the persona cookie the store seam reads (mirrors the
// dated-fact action tests).
let mockPersonaCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wl_demo_persona" && mockPersonaCookie
        ? { value: mockPersonaCookie }
        : undefined,
  }),
}));

afterEach(() => {
  mockPersonaCookie = undefined;
});

const TODAY = "2026-07-02";
const CLOCK: Clock = fixedClock(TODAY);

// A minimal object that passes `isWorthlineStoreLike` so it is picked up as the
// injected test store; the combinator only hands it to `run`.
const fakeStore = {
  workspace: {},
  assets: {},
  close: () => {},
} as unknown as WorthlineStore;

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

/** Run a redirect-form action and return the redirect digest (URL) it throws. */
async function runRedirect(action: () => Promise<never>): Promise<string> {
  try {
    await action();
    throw new Error("action did not redirect");
  } catch (err: unknown) {
    const e = err as { message?: string; digest?: string };
    if (e.message === "NEXT_REDIRECT" && typeof e.digest === "string") {
      return e.digest;
    }
    throw err;
  }
}

describe("formAction — redirect form choreography", () => {
  test("success: runs the command with the injected store + resolved today, then redirects to onSuccess", async () => {
    let receivedStore: WorthlineStore | undefined;
    let receivedToday: string | undefined;
    let receivedParsed: string | undefined;

    const action = formAction<string>({
      missingId: "Falta el id.",
      parse: ({ formData }) => ({ ok: true, value: String(formData.get("body")) }),
      run: async (store, { today, parsed }) => {
        receivedStore = store;
        receivedToday = today;
        receivedParsed = parsed;
        return { ok: true };
      },
      onError: ({ id, error }) => errorRedirectUrl(`/x/${id}`, { message: error }),
      onSuccess: ({ id }) => successRedirectUrl(`/x/${id}`, "done", id),
    });

    const url = await runRedirect(() =>
      action(form({ id: "e1", body: "payload" }), fakeStore, CLOCK),
    );

    expect(receivedStore).toBe(fakeStore);
    expect(receivedToday).toBe(TODAY);
    expect(receivedParsed).toBe("payload");
    expect(url).toContain("ok=done");
  });

  test("missing primary id: redirects to the section list with the missingId message, never runs", async () => {
    let ran = false;
    const action = formAction({
      missingId: "Falta el id de deuda.",
      parse: () => ({ ok: true, value: null }),
      run: async () => {
        ran = true;
        return { ok: true };
      },
      onError: () => "/e",
      onSuccess: () => "/s",
    });

    const url = await runRedirect(() => action(form({ body: "x" }), fakeStore, CLOCK));
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(
      "Falta el id de deuda.",
    );
    expect(url).toContain("/patrimonio");
    expect(ran).toBe(false);
  });

  test("missing extra id: redirects with the missingId message, never runs", async () => {
    let ran = false;
    const action = formAction({
      extraIds: ["anchorId"],
      missingId: "Falta el saldo.",
      parse: () => ({ ok: true, value: null }),
      run: async () => {
        ran = true;
        return { ok: true };
      },
      onError: () => "/e",
      onSuccess: () => "/s",
    });

    const url = await runRedirect(() => action(form({ id: "e1" }), fakeStore, CLOCK));
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain("Falta el saldo.");
    expect(ran).toBe(false);
  });

  test("parse failure: redirects to the parse-supplied URL with preserved fields, never runs", async () => {
    let ran = false;
    const action = formAction({
      missingId: "Falta el id.",
      parse: ({ id }) => ({
        ok: false,
        redirect: errorRedirectUrl(`/x/${id}`, {
          message: "Campo inválido.",
          values: { balance: "abc" },
        }),
      }),
      run: async () => {
        ran = true;
        return { ok: true };
      },
      onError: () => "/e",
      onSuccess: () => "/s",
    });

    const url = await runRedirect(() =>
      action(form({ id: "e1", balance: "abc" }), fakeStore, CLOCK),
    );
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain("Campo inválido.");
    expect(decoded).toContain("balance");
    expect(ran).toBe(false);
  });

  test("run failure: redirects to onError with the command's message", async () => {
    const action = formAction({
      missingId: "Falta el id.",
      parse: () => ({ ok: true, value: null }),
      run: async () => ({ ok: false, error: "No se encontró la deuda." }),
      onError: ({ id, error }) => errorRedirectUrl(`/x/${id}`, { message: error }),
      onSuccess: () => "/s",
    });

    const url = await runRedirect(() => action(form({ id: "e1" }), fakeStore, CLOCK));
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(
      "No se encontró la deuda.",
    );
  });

  test("duplicate-date collision: a UNIQUE throw becomes the friendly duplicate message via onError", async () => {
    const action = formAction({
      missingId: "Falta el id.",
      parse: () => ({ ok: true, value: null }),
      run: async () => {
        throw { code: "SQLITE_CONSTRAINT_UNIQUE" };
      },
      onError: ({ id, error }) => errorRedirectUrl(`/x/${id}`, { message: error }),
      onSuccess: () => "/s",
    });

    const url = await runRedirect(() => action(form({ id: "e1" }), fakeStore, CLOCK));
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(
      DUPLICATE_DATED_FACT_MESSAGE,
    );
  });

  test("demo mode: blocks the write, redirecting with the demo message, never runs", async () => {
    mockPersonaCookie = "familia";
    let ran = false;
    const action = formAction({
      missingId: "Falta el id.",
      parse: () => ({ ok: true, value: null }),
      run: async () => {
        ran = true;
        return { ok: true };
      },
      onError: () => "/e",
      onSuccess: () => "/s",
    });

    const url = await runRedirect(() =>
      action(form({ id: "e1", currentUrl: "/x/e1" }), fakeStore, CLOCK),
    );
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(DEMO_DISABLED_MESSAGE);
    expect(ran).toBe(false);
  });
});

describe("formActionState — useActionState form choreography", () => {
  const IDLE = { ok: false as const, error: "" };

  test("success: returns an ok state carrying the run payload", async () => {
    const action = formActionState<string, { id: string }>({
      missingId: "Falta el id.",
      parse: ({ formData }) => ({ ok: true, value: String(formData.get("body")) }),
      run: async (_store, { id }) => ({ ok: true, id }),
    });

    const state = await action(IDLE, form({ id: "e1", body: "x" }), fakeStore, CLOCK);
    expect(state).toEqual({ ok: true, id: "e1" });
  });

  test("parse failure: returns an error state with the message and refill values", async () => {
    const action = formActionState({
      missingId: "Falta el id.",
      parse: () => ({
        ok: false,
        error: "Campo inválido.",
        values: { balance: "abc" },
      }),
      run: async () => ({ ok: true }),
    });

    const state = await action(IDLE, form({ id: "e1" }), fakeStore, CLOCK);
    expect(state).toEqual({
      ok: false,
      error: "Campo inválido.",
      values: { balance: "abc" },
    });
  });

  test("missing id: returns an error state with the missingId message", async () => {
    const action = formActionState({
      missingId: "Falta el id.",
      parse: () => ({ ok: true, value: null }),
      run: async () => ({ ok: true }),
    });

    const state = await action(IDLE, form({ body: "x" }), fakeStore, CLOCK);
    expect(state).toEqual({ ok: false, error: "Falta el id." });
  });

  test("run failure: returns an error state with the command's message", async () => {
    const action = formActionState({
      missingId: "Falta el id.",
      parse: () => ({ ok: true, value: null }),
      run: async () => ({ ok: false, error: "No se encontró la deuda." }),
    });

    const state = await action(IDLE, form({ id: "e1" }), fakeStore, CLOCK);
    expect(state).toEqual({ ok: false, error: "No se encontró la deuda." });
  });

  test("duplicate-date collision: returns the friendly duplicate message as an error state", async () => {
    const action = formActionState({
      missingId: "Falta el id.",
      parse: () => ({ ok: true, value: null }),
      run: async () => {
        throw { code: "SQLITE_CONSTRAINT_UNIQUE" };
      },
    });

    const state = await action(IDLE, form({ id: "e1" }), fakeStore, CLOCK);
    expect(state).toEqual({ ok: false, error: DUPLICATE_DATED_FACT_MESSAGE });
  });

  test("demo mode: blocks the write by redirecting (never returns a state)", async () => {
    mockPersonaCookie = "familia";
    let ran = false;
    const action = formActionState({
      missingId: "Falta el id.",
      parse: () => ({ ok: true, value: null }),
      run: async () => {
        ran = true;
        return { ok: true };
      },
    });

    const digest = await runRedirect(
      () =>
        action(
          IDLE,
          form({ id: "e1", currentUrl: "/x/e1" }),
          fakeStore,
          CLOCK,
        ) as Promise<never>,
    );
    expect(decodeURIComponent(digest.replace(/\+/g, " "))).toContain(
      DEMO_DISABLED_MESSAGE,
    );
    expect(ran).toBe(false);
  });
});

describe("formAction — generalized capabilities (#1114)", () => {
  test("requireId:false runs a whole-workspace action with no id, id is empty string", async () => {
    let receivedId: string | undefined;
    const action = formAction({
      requireId: false,
      run: async (_store, { id }) => {
        receivedId = id;
        return { ok: true };
      },
      onError: () => "/e",
      onSuccess: () => successRedirectUrl("/patrimonio", "trash_emptied"),
    });

    const url = await runRedirect(() => action(form({}), fakeStore, CLOCK));
    expect(receivedId).toBe("");
    expect(url).toContain("trash_emptied");
  });

  test("run receives now off the clock (not only today)", async () => {
    let receivedNow: string | undefined;
    const action = formAction({
      requireId: false,
      run: async (_store, { now }) => {
        receivedNow = now;
        return { ok: true };
      },
      onError: () => "/e",
      onSuccess: () => "/s",
    });

    await runRedirect(() => action(form({}), fakeStore, CLOCK));
    // fixedClock(TODAY).now() is the day's ISO timestamp — starts with the date.
    expect(receivedNow).toContain(TODAY);
  });

  test("onSuccess receives the run payload (e.g. a batch count)", async () => {
    const action = formAction<undefined, { count: number }>({
      requireId: false,
      run: async () => ({ ok: true, value: { count: 3 } }),
      onError: () => "/e",
      onSuccess: ({ value }) =>
        successRedirectUrl("/patrimonio", value?.count === 0 ? "saved" : "updated"),
    });

    const url = await runRedirect(() => action(form({}), fakeStore, CLOCK));
    expect(url).toContain("ok=updated");
  });

  test("datedFact:false does NOT translate a UNIQUE throw — the raw error propagates", async () => {
    const action = formAction({
      datedFact: false,
      missingId: "Falta el id.",
      run: async () => {
        throw { code: "SQLITE_CONSTRAINT_UNIQUE" };
      },
      onError: ({ error }) => errorRedirectUrl("/x", { message: error }),
      onSuccess: () => "/s",
    });

    await expect(action(form({ id: "e1" }), fakeStore, CLOCK)).rejects.toMatchObject({
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
  });

  test("afterCommit runs on success, after the cycle, before the redirect, with the run payload", async () => {
    const order: string[] = [];
    const action = formAction<undefined, { memberId: string }>({
      requireId: false,
      run: async () => {
        order.push("run");
        return { ok: true, value: { memberId: "m1" } };
      },
      afterCommit: async ({ value }) => {
        order.push(`afterCommit:${value?.memberId}`);
      },
      onError: () => "/e",
      onSuccess: () => {
        order.push("onSuccess");
        return successRedirectUrl("/app", "done");
      },
    });

    const url = await runRedirect(() => action(form({}), fakeStore, CLOCK));
    expect(order).toEqual(["run", "afterCommit:m1", "onSuccess"]);
    expect(url).toContain("ok=done");
  });

  test("afterCommit does NOT run when the command fails", async () => {
    let afterCommitRan = false;
    const action = formAction({
      requireId: false,
      run: async () => ({ ok: false, error: "boom" }),
      afterCommit: async () => {
        afterCommitRan = true;
      },
      onError: ({ error }) => errorRedirectUrl("/x", { message: error }),
      onSuccess: () => "/s",
    });

    await runRedirect(() => action(form({}), fakeStore, CLOCK));
    expect(afterCommitRan).toBe(false);
  });

  test("guardUrl overrides where a blocked demo write redirects", async () => {
    mockPersonaCookie = "familia";
    const action = formAction({
      requireId: false,
      guardUrl: () => "/ajustes",
      run: async () => ({ ok: true }),
      onError: () => "/e",
      onSuccess: () => "/s",
    });

    const url = await runRedirect(() => action(form({}), fakeStore, CLOCK));
    const decoded = decodeURIComponent(url.replace(/\+/g, " "));
    expect(decoded).toContain(DEMO_DISABLED_MESSAGE);
    expect(url).toContain("/ajustes");
  });

  test("missingIdUrl routes the missing-id error to the form's own page", async () => {
    const action = formAction({
      missingId: "Falta el id.",
      missingIdUrl: (fd) => (fd.get("currentUrl") as string) || "/patrimonio",
      run: async () => ({ ok: true }),
      onError: () => "/e",
      onSuccess: () => "/s",
    });

    const url = await runRedirect(() =>
      action(form({ currentUrl: "/patrimonio/x/editar" }), fakeStore, CLOCK),
    );
    expect(url).toContain("/patrimonio/x/editar");
  });
});
