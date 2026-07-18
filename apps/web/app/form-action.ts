import {
  isClock,
  runActionWithStore,
  runDatedFactAction,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import { errorRedirectUrl, parseEntityId } from "@web/intake";
import { type WorthlineStore } from "@web/store";
import { type Clock, systemClock } from "@worthline/domain";
import { redirect } from "next/navigation";

/**
 * The combinator that owns the full choreography of a **mutating** server action
 * (PRD #1112). Every such action re-wrote the same six-band shell by hand: the
 * `_testArgs` test-seam ritual (store + clock injection), the demo/impersonation
 * write guard, the required-id parse, resolving `today`/`now` off the clock, the
 * store cycle, and the terminal redirect (or, for a `useActionState` form, the
 * terminal state). This module lifts that shell so an action supplies ONLY what
 * genuinely varies: which ids it needs, how it parses the body, the command it
 * runs, and its success/error surface.
 *
 * The `datedFactAction` factory that lived inline in `patrimonio/actions.ts` was
 * the embryo (#1028); this generalizes it into a shared module with TWO forms —
 * {@link formAction} (redirect) and {@link formActionState} (`useActionState`) —
 * that share one front matter. The mutation barrier does NOT move: the commands
 * (ADR 0062) stay the frontier; the combinator owns only the web choreography in
 * front of them.
 *
 * Two invariants live in the shared cycle and so can never be forgotten in a new
 * action: the demo-write guard, and — for a dated-fact write (`datedFact: true`,
 * the default) — the duplicate-date translation (`runDatedFactAction`, #692) that
 * turns a UNIQUE-index collision into a friendly `{ ok: false }` instead of a raw
 * 500. Plain writes (`datedFact: false`) skip that translation so a genuine
 * constraint bug still surfaces rather than being mislabeled as a duplicate date.
 */

/** Base page URL the demo/impersonation guard returns to when a write is blocked. */
const DEFAULT_GUARD_URL = "/patrimonio";

/** The guard target — the form's own `currentUrl`, or the section list as fallback. */
export function currentUrlOrDefault(formData: FormData): string {
  return (formData.get("currentUrl") as string) || DEFAULT_GUARD_URL;
}

/** The extra required ids, keyed by their form field name (e.g. `extra.planId`). */
export type FormActionExtraIds = Readonly<Record<string, string>>;

/** Result of the guarded command: success (with an optional payload) or a message. */
export type FormRunResult<R> = { ok: true; value?: R } | { ok: false; error: string };

type FrontMatter = {
  /** Injected in-memory store when a test passes one; undefined in production. */
  store: WorthlineStore | undefined;
  /** `today` resolved off the injected or system clock. */
  today: string;
  /** `now` (a wall-clock timestamp) resolved off the same clock. */
  now: string;
  /** The primary entity id (`id`), or null when the form omitted it. */
  id: string | null;
  /** Extra required ids, keyed by field name; complete only when `missingExtra` is false. */
  extra: Record<string, string>;
  /** True when a required extra id was absent — the caller must short-circuit. */
  missingExtra: boolean;
};

/**
 * The shared front matter of every mutating action: lift the test store + clock
 * seams, run the demo/impersonation guard (which redirects on a blocked write —
 * correct for both forms), then parse the primary id and any extra ids. Both
 * combinator forms build their terminal on top of this.
 */
async function resolveFrontMatter(
  formData: FormData,
  testArgs: readonly unknown[],
  extraIds: readonly string[] | undefined,
  guardUrl: (formData: FormData) => string,
): Promise<FrontMatter> {
  const store = testStoreFromActionArgs(testArgs);
  const clock: Clock = testArgFromActionArgs(testArgs, isClock) ?? systemClock();
  await guardDemoWrite(guardUrl(formData));

  const id = parseEntityId(formData);
  // Key each extra id by its field name so consumers read `extra.planId` instead
  // of a positional index — a reordered `extraIds` can't silently break them.
  const extra: Record<string, string> = {};
  let missingExtra = false;
  for (const field of extraIds ?? []) {
    const value = parseEntityId(formData, field);
    if (!value) {
      missingExtra = true;
      break;
    }
    extra[field] = value;
  }

  return { store, today: clock.today(), now: clock.now(), id, extra, missingExtra };
}

/** Run the guarded command with the chosen store cycle (dated-fact-safe or plain). */
function runStoreCycle<R>(
  datedFact: boolean,
  fn: (store: WorthlineStore) => Promise<FormRunResult<R>>,
  store: WorthlineStore | undefined,
): Promise<FormRunResult<R>> {
  return datedFact ? runDatedFactAction(fn, store) : runActionWithStore(fn, store);
}

/** Parse result for the redirect form: on failure it carries the redirect URL to send. */
export type FormActionParse<P> = { ok: true; value: P } | { ok: false; redirect: string };

/** The ids + form + run payload available to the redirect form's terminal builders. */
type RedirectInput<R> = {
  id: string;
  extra: FormActionExtraIds;
  formData: FormData;
  /** The value `run` returned on success; `undefined` on the error path. */
  value: R | undefined;
};

/** The parse/run context threaded through a redirect-form action. */
type ActionContext<P> = {
  formData: FormData;
  id: string;
  extra: FormActionExtraIds;
  today: string;
  now: string;
  parsed: P;
};

/** Configuration for the **redirect** form of the combinator. */
export type FormActionConfig<P, R = void> = {
  /** Extra id fields required beyond `id` (e.g. `["planId", "revisionId"]`). */
  extraIds?: readonly string[];
  /**
   * Where the demo/impersonation write guard redirects a blocked write. Default:
   * the form's own `currentUrl`, or `/patrimonio`. Override for a section whose
   * guard target differs (e.g. `() => "/ajustes"`, or a per-holding edit page).
   */
  guardUrl?: (formData: FormData) => string;
  /**
   * Whether the action requires a primary `id` field. Default `true`. Set `false`
   * for actions that operate on the whole workspace (e.g. empty trash, batch
   * value update), where `id` is `""` throughout.
   */
  requireId?: boolean;
  /** Message shown (redirecting) when a required id is absent. Required unless `requireId` is false. */
  missingId?: string;
  /** Where the missing-id error redirects. Default: the section list (`/patrimonio`). */
  missingIdUrl?: (formData: FormData) => string;
  /**
   * Whether to run the command behind the dated-fact cycle (UNIQUE→friendly
   * duplicate-date message, #692). Default `true`. Set `false` for a plain write.
   */
  datedFact?: boolean;
  /** Parse + validate the body; on failure carries the redirect URL. Omit for id-only actions. */
  parse?: (input: {
    formData: FormData;
    id: string;
    extra: FormActionExtraIds;
    today: string;
    now: string;
  }) => FormActionParse<P>;
  /** The guarded command, run inside the store cycle. */
  run: (store: WorthlineStore, ctx: ActionContext<P>) => Promise<FormRunResult<R>>;
  /** Redirect URL when `run` returns `{ ok: false }`. */
  onError: (input: Omit<RedirectInput<R>, "value"> & { error: string }) => string;
  /**
   * A best-effort side effect run AFTER the mutation commits (the store cycle has
   * closed) and BEFORE the success redirect — the seam for the work that used to
   * sit between `}, _store)` and `redirect(...)`: registering an exposure-catalog
   * stub (#1097), or pointing the scope cookie at a freshly-imported member. It
   * receives the run payload. It runs only on success; a throw propagates, so a
   * genuinely-optional effect (a catalog stub) must swallow its own errors, while
   * one whose failure should abort the redirect (a required cookie) may throw.
   */
  afterCommit?: (input: RedirectInput<R>) => Promise<void>;
  /** Redirect URL on success (receives the run payload). */
  onSuccess: (input: RedirectInput<R>) => string;
};

/**
 * The **redirect** form: the action redirects on every terminal (missing id,
 * parse failure, run failure, success), so it returns `Promise<never>`. This is
 * the shape the classic `<form action={...}>` server actions use.
 */
export function formAction<P = undefined, R = void>(
  config: FormActionConfig<P, R>,
): (formData: FormData, ..._testArgs: unknown[]) => Promise<never> {
  const requireId = config.requireId ?? true;
  const datedFact = config.datedFact ?? true;
  const missingIdUrl = config.missingIdUrl ?? (() => DEFAULT_GUARD_URL);
  const guardUrl = config.guardUrl ?? currentUrlOrDefault;

  return async (formData, ..._testArgs) => {
    const {
      store,
      today,
      now,
      id: primaryId,
      extra,
      missingExtra,
    } = await resolveFrontMatter(formData, _testArgs, config.extraIds, guardUrl);

    if ((requireId && !primaryId) || missingExtra) {
      redirect(
        errorRedirectUrl(missingIdUrl(formData), {
          message: config.missingId ?? "Falta un identificador.",
        }),
      );
    }
    const id = primaryId ?? "";

    const parsed = config.parse
      ? config.parse({ formData, id, extra, today, now })
      : ({ ok: true, value: undefined as P } as const);
    if (!parsed.ok) {
      redirect(parsed.redirect);
    }

    const result = await runStoreCycle(
      datedFact,
      (s) => config.run(s, { formData, id, extra, today, now, parsed: parsed.value }),
      store,
    );

    if (!result.ok) {
      redirect(config.onError({ id, extra, formData, error: result.error }));
    }

    const committed = { id, extra, formData, value: result.value };
    if (config.afterCommit) {
      await config.afterCommit(committed);
    }
    redirect(config.onSuccess(committed));
  };
}

/**
 * Serializable result of the `useActionState` form — `ok: true` (optionally
 * carrying a success payload `S`) or `ok: false` with a message and the fields
 * to refill. Shaped so a client form re-renders inline instead of navigating.
 */
export type FormActionState<S extends object = Record<never, never>> =
  | ({ ok: true } & S)
  | { ok: false; error: string; values?: Record<string, string> };

/** Parse result for the state form: on failure it carries the message + refill values. */
export type FormActionStateParse<P> =
  | { ok: true; value: P }
  | { ok: false; error: string; values?: Record<string, string> };

/** Configuration for the **`useActionState`** form of the combinator. */
export type FormActionStateConfig<P, S extends object> = {
  /** Extra id fields required beyond `id`. */
  extraIds?: readonly string[];
  /** Where the demo/impersonation write guard redirects a blocked write. Default: `currentUrl` or `/patrimonio`. */
  guardUrl?: (formData: FormData) => string;
  /** Whether the action requires a primary `id` field. Default `true`. */
  requireId?: boolean;
  /** Error message returned when a required id is absent. Required unless `requireId` is false. */
  missingId?: string;
  /** Whether to run behind the dated-fact cycle (#692). Default `true`. */
  datedFact?: boolean;
  /** Parse + validate the body; on failure carries the message + refill values. */
  parse?: (input: {
    formData: FormData;
    id: string;
    extra: FormActionExtraIds;
    today: string;
    now: string;
  }) => FormActionStateParse<P>;
  /** The guarded command, run inside the store cycle. */
  run: (
    store: WorthlineStore,
    ctx: ActionContext<P>,
  ) => Promise<({ ok: true } & S) | { ok: false; error: string }>;
};

/**
 * The **`useActionState`** form: same front matter and store cycle as
 * {@link formAction}, but every terminal returns a serializable
 * {@link FormActionState} instead of redirecting — so a client form can show the
 * error (or success payload) inline. The demo/impersonation guard still
 * redirects (a blocked write must never fall through to a rendered state).
 */
export function formActionState<P = undefined, S extends object = Record<never, never>>(
  config: FormActionStateConfig<P, S>,
): (
  _prevState: FormActionState<S>,
  formData: FormData,
  ..._testArgs: unknown[]
) => Promise<FormActionState<S>> {
  const requireId = config.requireId ?? true;
  const datedFact = config.datedFact ?? true;
  const guardUrl = config.guardUrl ?? currentUrlOrDefault;

  return async (_prevState, formData, ..._testArgs) => {
    const {
      store,
      today,
      now,
      id: primaryId,
      extra,
      missingExtra,
    } = await resolveFrontMatter(formData, _testArgs, config.extraIds, guardUrl);

    if ((requireId && !primaryId) || missingExtra) {
      return { ok: false, error: config.missingId ?? "Falta un identificador." };
    }
    const id = primaryId ?? "";

    const parsed = config.parse
      ? config.parse({ formData, id, extra, today, now })
      : ({ ok: true, value: undefined as P } as const);
    if (!parsed.ok) {
      return parsed.values
        ? { ok: false, error: parsed.error, values: parsed.values }
        : { ok: false, error: parsed.error };
    }

    const result = await runStoreCycle(
      datedFact,
      (s) => config.run(s, { formData, id, extra, today, now, parsed: parsed.value }),
      store,
    );

    if (!result.ok) {
      return { ok: false, error: result.error ?? "No se pudo completar la acción." };
    }

    return result;
  };
}
