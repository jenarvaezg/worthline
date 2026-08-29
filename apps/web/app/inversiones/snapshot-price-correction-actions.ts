"use server";

/**
 * Single-date snapshot price correction (#926).
 *
 * Preview validates the date and price and dry-runs the seam; confirm
 * re-validates and applies. Its own module since #1606.
 */

import {
  isClock,
  runActionWithStore,
  testArgFromActionArgs,
  testStoreFromActionArgs,
} from "@web/action-store";
import { guardDemoWrite } from "@web/demo/write-guard";
import { formAction } from "@web/form-action";
import { errorRedirectUrl, snapshotPriceCorrectionDoneRedirectUrl } from "@web/intake";
import { currentUrlOf } from "@web/inversiones/return-url";
import type { WorthlineStore } from "@web/store";
import {
  planSnapshotPriceCorrection,
  snapshotPriceCorrectionErrorMessage,
  systemClock,
} from "@worthline/domain";

/** Preview state for correcting one daily snapshot's unit price. */
export type SnapshotPriceCorrectionPreviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "not_eligible" }
  | {
      status: "summary";
      dateKey: string;
      unitPrice: string;
      units: string;
      valueMinor: number;
      create: number;
      update: number;
    };

async function readSnapshotPriceCorrectionContext(
  store: WorthlineStore,
  assetId: string,
): Promise<{
  operations: Awaited<ReturnType<WorthlineStore["operations"]["readOperations"]>>;
} | null> {
  const investment = await store.assets.readInvestmentAssetById(assetId);
  if (!investment) return null;

  const operations = await store.operations.readOperations(assetId);
  if (operations.length === 0) return null;

  return { operations };
}

function parseSnapshotPriceCorrectionForm(formData: FormData): {
  dateKey: string;
  unitPriceRaw: string;
} {
  return {
    dateKey: String(formData.get("dateKey") ?? "").trim(),
    unitPriceRaw: String(formData.get("unitPrice") ?? "").trim(),
  };
}

async function planCorrectionFromForm(
  store: WorthlineStore,
  assetId: string,
  formData: FormData,
  today: string,
) {
  const context = await readSnapshotPriceCorrectionContext(store, assetId);
  if (!context) return { kind: "not_eligible" as const };

  const { dateKey, unitPriceRaw } = parseSnapshotPriceCorrectionForm(formData);
  const existingSnapshotDates = new Set(
    (
      await store.snapshots.readSnapshotHoldings({
        holdingId: assetId,
        kind: "asset",
      })
    ).map((row) => row.dateKey),
  );

  const plan = planSnapshotPriceCorrection({
    dateKey,
    existingSnapshotDates,
    operations: context.operations,
    today,
    unitPriceRaw,
  });
  if (!plan.ok) {
    return {
      kind: "error" as const,
      message: snapshotPriceCorrectionErrorMessage(plan.reason),
    };
  }

  return { kind: "plan" as const, point: plan.point };
}

/**
 * Single-date snapshot price correction preview (#926). Validates the chosen date
 * and unit price, then runs the apply seam in dry-run mode — returning the
 * create/update counts and the valued row WITHOUT writing anything.
 */
export async function previewSnapshotPriceCorrectionAction(
  routeAssetId: string,
  _prev: SnapshotPriceCorrectionPreviewState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<SnapshotPriceCorrectionPreviewState> {
  const _store = testStoreFromActionArgs(_testArgs);
  const _clock = testArgFromActionArgs(_testArgs, isClock) ?? systemClock();
  await guardDemoWrite(currentUrlOf(formData));

  const planned = await runActionWithStore(
    (store) => planCorrectionFromForm(store, routeAssetId, formData, _clock.today()),
    _store,
  );
  if (planned.kind === "not_eligible") return { status: "not_eligible" };
  if (planned.kind === "error") return { status: "error", message: planned.message };

  const result = await runActionWithStore(
    (store) =>
      store.command.correctInvestmentSnapshotUnitPrice({
        assetId: routeAssetId,
        dateKey: planned.point.dateKey,
        dryRun: true,
        unitPriceDecimal: planned.point.unitPriceDecimal,
      }),
    _store,
  );

  return {
    create: result.created,
    dateKey: planned.point.dateKey,
    status: "summary",
    unitPrice: planned.point.unitPriceDecimal,
    units: planned.point.units,
    update: result.updated,
    valueMinor: planned.point.valueMinor,
  };
}

/**
 * Single-date snapshot price correction confirm (#926). Re-validates the form
 * (never trusting the preview), applies the correction through the atomic store
 * seam, and redirects with the corrected date.
 */
export async function confirmSnapshotPriceCorrectionAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);

  return formAction<undefined, { dateKey: string }>({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) => errorRedirectUrl(returnUrl, { message: error }),
    onSuccess: ({ value }) =>
      snapshotPriceCorrectionDoneRedirectUrl(returnUrl, value!.dateKey),
    requireId: false,
    run: async (store, { today }) => {
      const planned = await planCorrectionFromForm(store, routeAssetId, formData, today);
      if (planned.kind === "not_eligible") {
        return { error: "Esta inversión no admite corrección de snapshot.", ok: false };
      }
      if (planned.kind === "error") return { error: planned.message, ok: false };

      await store.command.correctInvestmentSnapshotUnitPrice({
        assetId: routeAssetId,
        dateKey: planned.point.dateKey,
        unitPriceDecimal: planned.point.unitPriceDecimal,
      });
      return { ok: true, value: { dateKey: planned.point.dateKey } };
    },
  })(formData, ..._testArgs);
}
