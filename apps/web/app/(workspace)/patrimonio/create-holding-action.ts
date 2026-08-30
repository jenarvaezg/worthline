"use server";

import { markFirstHoldingBestEffort } from "@web/activation-marks";
import {
  type ExposureCatalogStubCandidate,
  ensureExposureCatalogStubs,
} from "@web/ensure-exposure-catalog-stubs";
import { fetchFirstQuoteBestEffort } from "@web/first-quote";
import { formAction } from "@web/form-action";
import { holdingDetailHref } from "@web/holding-route";
import {
  appendParam,
  errorRedirectUrl,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import type { AltaCreated } from "@web/patrimonio/anadir/_families/alta-contract";
import { altaCommandFor } from "@web/patrimonio/anadir/_families/alta-dispatch";
import { altaRoute } from "@web/patrimonio/anadir/_families/alta-route";
import {
  normalizeSimpleDrawerForm,
  SIMPLE_FIELD_KEYS,
} from "@web/patrimonio/anadir/simple-drawer-form";
import type { WorthlineStore } from "@web/store";
import type { InvestmentAssetRef } from "@worthline/pricing";
import { holdingBoardAnchor } from "./action-helpers";

/**
 * The unified «Añadir holding» server action (issue #151, PRD #146 S5; split by
 * family in #1611).
 *
 * What is left here is the orchestration, and only that:
 *
 * 1. Which surface the submission came from, and therefore where it returns.
 * 2. Which instrument it chose — the simple wizard's drawers are translated
 *    first (`normalizeSimpleDrawerForm`), so everything below reads one shape.
 * 3. Which family that instrument belongs to (`altaRoute`), and running that
 *    family's command (`altaCommandFor`).
 * 4. Turning the command's answer into a URL: the refill on a rejection, the
 *    ok-key + board anchor on a success.
 *
 * Step 4 is the action's own job rather than a family's because the destination
 * is a property of WHERE the alta was submitted from — the wizard loops back to
 * its own success panel, the avanzado form lands on the holdings list — and no
 * command needs to know that to create a holding.
 *
 * There is no branch on the instrument here any more. Adding one is adding a row
 * to the instrument catalog; adding a family is adding a case to the dispatch and
 * a module beside it.
 */

/** Where the add flow returns on validation error. */
const ADD_URL = "/patrimonio/anadir";
const ADVANCED_ADD_URL = "/patrimonio/anadir/avanzado";

function parseReturnUrl(value: FormDataEntryValue | null): string {
  return String(value ?? "") === ADVANCED_ADD_URL ? ADVANCED_ADD_URL : ADD_URL;
}

/** The ownership footer and the instrument choice: preserved whatever fails. */
const ALWAYS_PRESERVED: readonly string[] = [
  "instrument",
  "ownershipPreset",
  "scopeMemberId",
];

/**
 * Where a consummated alta lands (#600, #1318, #1561).
 *
 * The simple wizard LOOPS: a successful add returns to it with a success panel
 * (the `ok` key plus the new holding's public `wl_hld_…` id as a query param the
 * server can read — the `#anchor` is client-only), so first runs chain adds
 * without friction. The avanzado flow lands on the holdings list instead, at the
 * new row.
 *
 * The holding is named by its PUBLIC id (#1318). Creation registers it, so a miss
 * is unreachable; if it ever happened the alta still succeeded, so the screen
 * drops the ficha link (the panel already renders without one) rather than 500
 * over a scroll position.
 *
 * `jumpToHolding: false` drops the board `#anchor`: when the redirect carries a
 * QUESTION, scrolling straight to the new row leaves the band that asks it
 * off-screen above (#1561). The wizard's `&added=` is untouched — it feeds the
 * success panel's ficha link, not a scroll position, and that panel IS the whole
 * screen.
 */
async function altaSuccessUrl(
  store: WorthlineStore,
  created: AltaCreated,
  returnUrl: string,
): Promise<string> {
  const publicId = await holdingBoardAnchor(store, created.holdingId);

  // «Importar extracto» routes straight to the ficha, so there the public id IS
  // the destination; without it there is no ficha URL to send anyone to and the
  // board is the honest landing.
  if (created.landing === "holding-ficha") {
    return successRedirectUrl(
      publicId ? holdingDetailHref(publicId) : "/patrimonio",
      created.okKey,
    );
  }

  const base =
    returnUrl === ADD_URL
      ? `${successRedirectUrl(ADD_URL, created.okKey)}${publicId ? `&added=${publicId}` : ""}`
      : successRedirectUrl(
          "/patrimonio",
          created.okKey,
          created.jumpToHolding === false ? undefined : publicId,
        );

  // The extra query params an ok-key's message reads (the acquisition question's
  // `deudaDesde`, #1561). `appendParam` inserts before the `#anchor`, not after.
  return Object.entries(created.params ?? {}).reduce(
    (url, [key, value]) => appendParam(url, key, value),
    base,
  );
}

export async function createHoldingAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const returnUrl = parseReturnUrl(formData.get("returnTo"));
  return formAction<
    undefined,
    {
      redirectUrl: string;
      catalog?: ExposureCatalogStubCandidate;
      firstQuote?: { asset: InvestmentAssetRef; nowIso: string };
    }
  >({
    requireId: false,
    datedFact: false,
    guardUrl: () => returnUrl,
    run: async (store, { today, now }) => {
      const normalized = normalizeSimpleDrawerForm(formData, today);
      const actionFormData = normalized.formData;
      const instrument = normalized.instrument;
      const route = instrument ? altaRoute(instrument) : null;

      // On error, reopen the chosen pane and refill what was typed. Before a
      // family is known there is nothing instrument-scoped to refill.
      const errorUrl = (message: string, fields: readonly string[] = []): string =>
        errorRedirectUrl(returnUrl, {
          formId: "holding",
          message,
          values: preserveFields(
            actionFormData,
            [...ALWAYS_PRESERVED, ...SIMPLE_FIELD_KEYS, ...fields],
            ["owner_"],
          ),
        });

      // No instrument, or one no family knows how to create. Neither has a pane
      // in the form, so there is nothing instrument-scoped to refill: what the
      // user typed lives in the wizard's own fields, which are always preserved.
      if (!instrument || !route) {
        return {
          ok: false,
          error: errorUrl(
            normalized.unsupported ??
              (instrument
                ? "Instrumento no soportado todavía."
                : "Elige un tipo de instrumento."),
          ),
        };
      }

      const command = altaCommandFor(route);
      const refill = command.refillFields.map((key) => `${key}_${instrument}`);

      // ONE clock reading for every id this alta mints (#1394's double-submit
      // caveat aside): they are already distinguished by prefix and name, so
      // giving them different milliseconds would be gratuitous.
      const result = await command.run({
        formData: actionFormData,
        instrument,
        now,
        seed: Date.now(),
        store,
        today,
      });

      if (!result.ok) {
        return { ok: false, error: errorUrl(result.message, refill) };
      }

      const { catalog, firstQuote } = result.created;

      return {
        ok: true,
        value: {
          redirectUrl: await altaSuccessUrl(store, result.created, returnUrl),
          ...(catalog ? { catalog } : {}),
          ...(firstQuote ? { firstQuote } : {}),
        },
      };
    },
    // The market holding is written — register its (empty) global-catalog row so
    // it surfaces in /admin/catalogo «por categorizar». Best-effort: never blocks
    // the redirect if the control plane is down (#1097).
    afterCommit: async ({ value }) => {
      if (value?.catalog) {
        await ensureExposureCatalogStubs([value.catalog]);
      }
      if (value?.firstQuote) {
        await fetchFirstQuoteBestEffort(value.firstQuote.asset, value.firstQuote.nowIso);
      }
      // First patrimonio write → stamp the set-once activation mark (#1131).
      await markFirstHoldingBestEffort();
    },
    onError: ({ error }) => error, // run already built the full URL
    onSuccess: ({ value }) => value!.redirectUrl,
  })(formData, ..._testArgs);
}
