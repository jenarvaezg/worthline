"use server";

/**
 * Manual daily capture for local mode, fired from /historico.
 *
 * ADR 0037 gives a hosted workspace a twice-daily cron; ADR 0030's local no-auth
 * mode has no control plane to enumerate and therefore no writer at all. This is
 * the local stand-in: it runs the SAME capture the cron runs
 * (`captureDailySnapshotForWorkspace`, the pure orchestration both share) so a
 * developer can record today's point by hand and watch /historico fill in.
 *
 * Only today's point, deliberately. `captureSnapshotForScope` derives `dateKey`
 * from `now`, so a past `now` would stamp present-day holdings — and today's
 * cached prices — under an old date, and ADR 0005's monthly close would go on
 * treating that fabrication as a real close. Seeding real history stays with
 * `bun run backfill:snapshots`.
 *
 * Prices are whatever the store already holds: this capture reads them, it does
 * not fetch them (`readCurveValuedHoldingsAtDate`), where the cron's
 * `runDailyCapture` refetches first. Press «Actualizar precios» on /patrimonio
 * before this when you want the day's real quotes rather than the last cached
 * ones.
 *
 * Built on the `formActionInlineError` combinator rather than hand-rolled: it
 * lifts the `_store`/`_clock` test seams, runs the demo/impersonation guard, and
 * — the reason it is the combinator and not a bare action like `refreshPricesAction`
 * — revalidates the router cache before the success terminal. This capture changes
 * what the page it redirects to already shows («N capturas»), and a redirect terminal
 * lands on a URL byte-identical to the one on screen; a success that revalidates is
 * the only terminal carrying a recovery net (interaction-patterns §4.1), so it must.
 *
 * ## Why this form and not plain `formAction`
 *
 * The **split** terminal (ADR 0036's #1311 amendment, interaction-patterns §4.1):
 * success redirects, and a **refusal comes back as state**. A redirect terminal is
 * losable, and a refusal's is losable *without a net* — it revalidated nothing, so
 * `actionQueue.needsRefresh` can never recover it and the reason vanishes, leaving an
 * emptied form and no band. The local refusal is the case that makes this concrete
 * rather than theoretical: the capture re-reads the whole workspace and can fail on a
 * plain store error, and a developer pressing «Capturar hoy» deserves to be told why.
 *
 * The opt-in is `inlineError=1`, stamped by the control in its submit handler and
 * never in the rendered HTML — a form posted with JavaScript off cannot carry it, so
 * `onErrorUrl` keeps the redirect terminal, the only one such a form can render. The
 * demo guard is upstream of the split (`resolveFrontMatter` redirects), and correctly
 * so: a blocked write must never fall through to a rendered state.
 */

import { type FormActionState, formActionInlineError } from "@web/form-action";
import { localCaptureRefusal } from "@web/historico/local-capture";
import { appendParam, errorRedirectUrl } from "@web/intake";
import { currentUrlOf } from "@web/inversiones/return-url";
import { readStoreTarget } from "@web/read-store-target";
import { captureDailySnapshotForWorkspace } from "@worthline/db";

/** Where the action returns when the form omits `currentUrl`. */
const FALLBACK_URL = "/historico";

/** Capture every scope's snapshot for today, stamping `now` off the action clock. */
export async function captureSnapshotAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<FormActionState> {
  return formActionInlineError<undefined, string>({
    // The whole workspace, so there is no primary id; and a plain write, not a
    // dated fact: the capture is latest-wins (ADR 0005), so re-capturing today is
    // an overwrite rather than the UNIQUE collision the dated-fact cycle assumes.
    requireId: false,
    datedFact: false,
    guardUrl: () => FALLBACK_URL,
    run: async (store, { today, now }) => {
      // The render gate on /historico decides whether the BUTTON exists; this
      // decides whether the WRITE runs. A crafted POST to a hosted deploy must
      // land on the same refusal the page would have shown, so re-check the
      // target here rather than trusting the UI.
      const refusal = localCaptureRefusal(await readStoreTarget());
      if (refusal !== null) {
        return { ok: false, error: refusal };
      }

      await captureDailySnapshotForWorkspace(store, now);
      return { ok: true, value: today };
    },
    // The same string both terminals say, so a refusal can never read one way in
    // the band and another way in the inline state. Nothing to refill: this form
    // asks for no field, which is why it can hand the reason back bare.
    onError: ({ error }) => ({ error }),
    onErrorUrl: ({ formData: fd, error }) =>
      errorRedirectUrl(currentUrlOf(fd, FALLBACK_URL), { message: error }),
    // `date` rides along so the banner can name the day that was captured
    // instead of saying «guardada» about an unnamed one. `ok` alone is enough to
    // identify the outcome, so a missing date degrades to the plain wording
    // rather than to a broken query — the shape `snapshotPriceCorrectionDone`
    // already uses for the same param.
    onSuccess: ({ formData: fd, value }) => {
      const url = appendParam(currentUrlOf(fd, FALLBACK_URL), "ok", "snapshot_captured");
      return value ? appendParam(url, "date", value) : url;
    },
  })(formData, ..._testArgs);
}
