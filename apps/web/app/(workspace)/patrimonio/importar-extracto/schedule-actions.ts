"use server";

/**
 * «Cuadro de amortización» lane of the portfolio import (#1406).
 *
 * Same door as the statement import, different reader — the decision recorded on
 * the issue («una puerta, dos lectores»). What travels here is not a ledger of
 * movements but the inputs of a generative model: the interest-rate revisions and
 * early repayments a bank's schedule reveals, written over a plan that already
 * exists. The plan row is never rewritten.
 *
 * Preview → confirm, like every other import: both re-read the uploaded file from
 * FormData (the file input stays mounted across both submits) and confirm
 * re-derives the whole plan from the store, so nothing the client reports is
 * trusted. Confirm applies all-or-nothing through
 * `importAmortizationScheduleAndRipple` — one transaction, one ripple.
 */

import { runActionWithStore, testStoreFromActionArgs } from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import { ingestionBlockedMessage } from "@web/entitlements/ingestion-guard";
import { PAYWALL_STATEMENT_MESSAGE } from "@web/entitlements/paywall-copy";
import { formAction } from "@web/form-action";
import { createStableId, errorRedirectUrl, successRedirectUrl } from "@web/intake";
import { readSpreadsheetGrids } from "@web/spreadsheet-grid";
import type { AddEarlyRepaymentInput, AddInterestRateRevisionInput } from "@worthline/db";
import {
  type AmortizationScheduleReading,
  type EarlyRepaymentMode,
  readAmortizationSchedule,
} from "@worthline/domain";

import {
  buildScheduleImportPreview,
  type ScheduleImportPreview,
} from "./schedule-import-preview";

export type { ScheduleImportTarget } from "./schedule-import-preview";

const UNREADABLE =
  "No he podido abrir el archivo. Sube el cuadro tal cual te lo da el banco: un .xlsx o un .csv.";

function currentUrlOf(formData: FormData): string {
  return (
    (formData.get("currentUrl") as string) ||
    "/patrimonio/importar-extracto?documento=cuadro"
  );
}

function modeOf(formData: FormData): EarlyRepaymentMode {
  return formData.get("earlyRepaymentMode") === "reduce-term"
    ? "reduce-term"
    : "reduce-payment";
}

async function readScheduleFromForm(
  formData: FormData,
): Promise<
  { ok: false; message: string } | { ok: true; value: AmortizationScheduleReading }
> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return {
      message: "Selecciona el cuadro de amortización de tu banco (.xlsx o .csv).",
      ok: false,
    };
  }

  const grids = readSpreadsheetGrids({
    bytes: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name,
  });
  if (grids.status !== "ok") return { message: UNREADABLE, ok: false };

  const reading = readAmortizationSchedule(grids.sheets);
  return reading.ok
    ? { ok: true, value: reading.value }
    : { message: reading.message, ok: false };
}

// ── Preview ───────────────────────────────────────────────────────────────

export type ImportScheduleState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "ready"; preview: Extract<ScheduleImportPreview, { ok: true }> };

export async function previewImportScheduleAction(
  _prev: ImportScheduleState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<ImportScheduleState> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));

  // Reading a bank document for you is premium ingestion (#1162); typing the
  // twenty-three revisions by hand stays free, as it always was.
  const paywall = await ingestionBlockedMessage(PAYWALL_STATEMENT_MESSAGE);
  if (paywall) return { message: paywall, status: "error" };

  const liabilityId = String(formData.get("liabilityId") ?? "").trim();
  if (liabilityId === "") {
    return { message: "Elige a qué deuda pertenece este cuadro.", status: "error" };
  }

  const read = await readScheduleFromForm(formData);
  if (!read.ok) return { message: read.message, status: "error" };

  return runActionWithStore(async (store) => {
    const preview = await buildScheduleImportPreview(store, {
      earlyRepaymentMode: modeOf(formData),
      liabilityId,
      reading: read.value,
    });
    return preview.ok
      ? { preview, status: "ready" }
      : { message: preview.message, status: "error" };
  }, _store);
}

// ── Confirm ───────────────────────────────────────────────────────────────

export async function confirmImportScheduleAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  const errorUrl = (message: string) =>
    errorRedirectUrl(currentUrlOf(formData), { formId: "schedule", message });

  return formAction<undefined, { revisions: number; earlyRepayments: number }>({
    requireId: false,
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    run: async (store, { formData, today }) => {
      const paywall = await ingestionBlockedMessage(PAYWALL_STATEMENT_MESSAGE);
      if (paywall) return { ok: false, error: paywall };

      const liabilityId = String(formData.get("liabilityId") ?? "").trim();
      if (liabilityId === "") {
        return { ok: false, error: "Elige a qué deuda pertenece este cuadro." };
      }

      const read = await readScheduleFromForm(formData);
      if (!read.ok) return { ok: false, error: read.message };

      // Re-derived from the store, never from the preview: a revision added by
      // hand between the two submits turns a «new» row into a duplicate, and
      // writing it anyway would put two rates on the same date.
      const preview = await buildScheduleImportPreview(store, {
        earlyRepaymentMode: modeOf(formData),
        liabilityId,
        reading: read.value,
      });
      if (!preview.ok) return { ok: false, error: preview.message };

      const seed = Date.now();
      const revisions: AddInterestRateRevisionInput[] = preview.value.revisions
        .filter((revision) => revision.status === "new")
        .map((revision, index) => ({
          id: createStableId(
            "rev",
            `${preview.planId}_${revision.revisionDate}`,
            seed + index,
          ),
          newAnnualInterestRate: revision.newAnnualInterestRate,
          planId: preview.planId,
          revisionDate: revision.revisionDate,
        }));
      const earlyRepayments: AddEarlyRepaymentInput[] = preview.value.earlyRepayments
        .filter((repayment) => repayment.status === "new")
        .map((repayment, index) => ({
          amountMinor: repayment.amountMinor,
          id: createStableId(
            "amo",
            `${preview.planId}_${repayment.repaymentDate}`,
            seed + 1000 + index,
          ),
          mode: repayment.mode,
          planId: preview.planId,
          repaymentDate: repayment.repaymentDate,
        }));

      if (revisions.length === 0 && earlyRepayments.length === 0) {
        return {
          ok: false,
          error:
            "Este cuadro no añade nada nuevo: ya tienes guardadas todas sus revisiones y amortizaciones.",
        };
      }

      await store.command.importAmortizationSchedule({
        earlyRepayments,
        liabilityId,
        revisions,
        today,
      });

      return {
        ok: true,
        value: { earlyRepayments: earlyRepayments.length, revisions: revisions.length },
      };
    },
    onError: ({ error }) => errorUrl(error),
    onSuccess: ({ value }) =>
      `${successRedirectUrl(currentUrlOf(formData), "schedule_import_loaded")}&revisiones=${value?.revisions}&anticipadas=${value?.earlyRepayments}`,
  })(formData, ..._testArgs);
}
