import {
  isClock,
  runDatedFactAction,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import { errorRedirectUrl, parseEntityId } from "@web/intake";
import { type WorthlineStore } from "@web/store";
import { systemClock } from "@worthline/domain";
import { redirect } from "next/navigation";

/**
 * The combinator that owns the full choreography of a **mutating** server action
 * (PRD #1112). Every such action re-wrote the same six-band shell by hand: the
 * `_testArgs` test-seam ritual (store + clock injection), the demo/impersonation
 * write guard, the required-id parse, resolving `today` off the clock, the store
 * cycle behind the dated-fact transaction, and the terminal redirect (or, for a
 * `useActionState` form, the terminal state). This module lifts that shell so an
 * action supplies ONLY what genuinely varies: which ids it needs, how it parses
 * the body, the command it runs, and its success/error surface.
 *
 * The `datedFactAction` factory that lived inline in `patrimonio/actions.ts` was
 * the embryo (#1028); this generalizes it into a shared module with TWO forms —
 * {@link formAction} (redirect) and {@link formActionState} (`useActionState`) —
 * that share one front matter. The mutation barrier does NOT move: the commands
 * (ADR 0062) stay the frontier; the combinator owns only the web choreography in
 * front of them.
 *
 * Two invariants live in the shared cycle and so can never be forgotten in a new
 * action: the demo-write guard, and the duplicate-date translation
 * (`runDatedFactAction`, #692) that turns a UNIQUE-index collision into a
 * friendly `{ ok: false }` instead of a raw 500.
 */

/** Base page URL the demo/impersonation guard returns to when a write is blocked. */
const DEFAULT_GUARD_URL = "/patrimonio";

/** The guard target — the form's own `currentUrl`, or the section list as fallback. */
function guardUrl(formData: FormData): string {
  return (formData.get("currentUrl") as string) || DEFAULT_GUARD_URL;
}

/** The extra required ids, keyed by their form field name (e.g. `extra.planId`). */
export type FormActionExtraIds = Readonly<Record<string, string>>;

type FrontMatter = {
  /** Injected in-memory store when a test passes one; undefined in production. */
  store: WorthlineStore | undefined;
  /** `today` resolved off the injected or system clock. */
  today: string;
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
): Promise<FrontMatter> {
  const store = testStoreFromActionArgs(testArgs);
  const clock = testArgFromActionArgs(testArgs, isClock) ?? systemClock();
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

  return { store, today: clock.today(), id, extra, missingExtra };
}

/** Parse result for the redirect form: on failure it carries the redirect URL to send. */
export type FormActionParse<P> = { ok: true; value: P } | { ok: false; redirect: string };

/** The ids + form available to the redirect form's success/error redirect builders. */
type RedirectInput = {
  id: string;
  extra: FormActionExtraIds;
  formData: FormData;
};

/** Configuration for the **redirect** form of the combinator. */
export type FormActionConfig<P> = {
  /** Extra id fields required beyond `id` (e.g. `["planId", "revisionId"]`). */
  extraIds?: readonly string[];
  /** Message shown (redirecting to the section list) when any required id is absent. */
  missingId: string;
  /** Parse + validate the body; on failure carries the redirect URL to send. */
  parse: (input: {
    formData: FormData;
    id: string;
    extra: FormActionExtraIds;
    today: string;
  }) => FormActionParse<P>;
  /** The guarded command, run inside the dated-fact store transaction. */
  run: (
    store: WorthlineStore,
    ctx: {
      formData: FormData;
      id: string;
      extra: FormActionExtraIds;
      today: string;
      parsed: P;
    },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Redirect URL when `run` returns `{ ok: false }`. */
  onError: (input: RedirectInput & { error: string }) => string;
  /** Redirect URL on success. */
  onSuccess: (input: RedirectInput) => string;
};

/**
 * The **redirect** form: the action redirects on every terminal (missing id,
 * parse failure, run failure, success), so it returns `Promise<never>`. This is
 * the shape the classic `<form action={...}>` server actions use.
 */
export function formAction<P>(
  config: FormActionConfig<P>,
): (formData: FormData, ..._testArgs: unknown[]) => Promise<never> {
  return async (formData, ..._testArgs) => {
    const {
      store,
      today,
      id: primaryId,
      extra,
      missingExtra,
    } = await resolveFrontMatter(formData, _testArgs, config.extraIds);

    if (!primaryId || missingExtra) {
      redirect(errorRedirectUrl(DEFAULT_GUARD_URL, { message: config.missingId }));
    }
    const id = primaryId;

    const parsed = config.parse({ formData, id, extra, today });
    if (!parsed.ok) {
      redirect(parsed.redirect);
    }

    const result = await runDatedFactAction(
      (s) => config.run(s, { formData, id, extra, today, parsed: parsed.value }),
      store,
    );

    if (!result.ok) {
      redirect(config.onError({ id, extra, formData, error: result.error! }));
    }

    redirect(config.onSuccess({ id, extra, formData }));
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
  /** Error message returned when any required id is absent. */
  missingId: string;
  /** Parse + validate the body; on failure carries the message + refill values. */
  parse: (input: {
    formData: FormData;
    id: string;
    extra: FormActionExtraIds;
    today: string;
  }) => FormActionStateParse<P>;
  /** The guarded command, run inside the dated-fact store transaction. */
  run: (
    store: WorthlineStore,
    ctx: {
      formData: FormData;
      id: string;
      extra: FormActionExtraIds;
      today: string;
      parsed: P;
    },
  ) => Promise<({ ok: true } & S) | { ok: false; error: string }>;
};

/**
 * The **`useActionState`** form: same front matter and store cycle as
 * {@link formAction}, but every terminal returns a serializable
 * {@link FormActionState} instead of redirecting — so a client form can show the
 * error (or success payload) inline. The demo/impersonation guard still
 * redirects (a blocked write must never fall through to a rendered state).
 */
export function formActionState<P, S extends object = Record<never, never>>(
  config: FormActionStateConfig<P, S>,
): (
  _prevState: FormActionState<S>,
  formData: FormData,
  ..._testArgs: unknown[]
) => Promise<FormActionState<S>> {
  return async (_prevState, formData, ..._testArgs) => {
    const {
      store,
      today,
      id: primaryId,
      extra,
      missingExtra,
    } = await resolveFrontMatter(formData, _testArgs, config.extraIds);

    if (!primaryId || missingExtra) {
      return { ok: false, error: config.missingId };
    }
    const id = primaryId;

    const parsed = config.parse({ formData, id, extra, today });
    if (!parsed.ok) {
      return parsed.values
        ? { ok: false, error: parsed.error, values: parsed.values }
        : { ok: false, error: parsed.error };
    }

    const result = await runDatedFactAction(
      (s) => config.run(s, { formData, id, extra, today, parsed: parsed.value }),
      store,
    );

    if (!result.ok) {
      return { ok: false, error: result.error ?? "No se pudo completar la acción." };
    }

    return result;
  };
}
