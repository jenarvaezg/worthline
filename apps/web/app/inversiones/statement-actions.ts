"use server";

/**
 * The per-holding statement upload — "Cargar extracto" (ADR 0018, #174/#175/#176).
 *
 * Preview counts what the merge would do without writing; confirm re-reads the
 * uploaded file (never trusting the preview) and merges by date in one command.
 * Its own module since #1606: adding a bucket here touches no other surface.
 */

import {
  runActionWithStore,
  testFxRatesOverride,
  testStoreFromActionArgs,
} from "@web/action-store";
import { markFirstHoldingBestEffort } from "@web/activation-marks";
import { guardDemoWrite } from "@web/demo/write-guard";
import {
  type ExposureCatalogStubCandidate,
  ensureExposureCatalogStubs,
} from "@web/ensure-exposure-catalog-stubs";
import { formAction } from "@web/form-action";
import {
  createStableId,
  errorRedirectUrl,
  mapDomainViolation,
  statementLoadedRedirectUrl,
} from "@web/intake";
import { currentUrlOf } from "@web/inversiones/return-url";
import {
  statementRowToCreateInput,
  statementRowToOverwrite,
} from "@web/statement-operation-input";
import type { ParsedStatement, StatementMergePlan } from "@worthline/domain";
import {
  isStatementBroker,
  parseStatement,
  planStatementMerge,
  resolvePerHoldingStatementIsinGuard,
  storedIsinOrNull,
} from "@worthline/domain";
import {
  type ConvertCapturedOperationsOptions,
  convertStatementRows,
} from "@worthline/pricing";

/**
 * The serializable result of a statement **preview** (ADR 0018, S3 / #176): the
 * counts the user confirms against, with nothing written. `idle` is the initial
 * useActionState value; `error` carries a Spanish message; `summary` carries the
 * merge-plan shape (new / overwritten) plus skipped pending/rejected rows.
 */
export type StatementPreviewState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "summary";
      created: number;
      overwritten: number;
      skipped: number;
      /** Ambiguous same-date rows set aside, neither created nor overwritten (S4). */
      anomalies: number;
      /** Rows detected as sells among those applied (S5). */
      sells: number;
    };

/** The Spanish error shown when the file's ISIN does not match the asset's (S4). */
function isinMismatchMessage(
  fileIsin: string | string[] | null,
  assetIsin: string,
): string {
  const fileLabel = Array.isArray(fileIsin) ? fileIsin.join(", ") : (fileIsin ?? "—");
  return `El ISIN del archivo (${fileLabel}) no coincide con el de esta inversión (${assetIsin}). No se ha cargado nada.`;
}

/** Count the sells among the rows a plan will actually write (created + overwritten). */
function countSells(plan: StatementMergePlan): number {
  return [...plan.toCreate, ...plan.toOverwrite.map(({ row }) => row)].filter(
    (row) => row.kind === "sell",
  ).length;
}

/**
 * Validate + parse the uploaded statement from the form, with no DB access — the
 * shared front half of preview and confirm. Returns the parsed statement or a
 * single Spanish error. The file is re-read here on BOTH steps, so confirm never
 * trusts the preview: the mounted file travels with each submission (ADR 0018,
 * mirroring the Import flow) and is re-validated server-side before any write.
 */
async function readStatementFromForm(
  formData: FormData,
  fxOptions: ConvertCapturedOperationsOptions = {},
): Promise<{ ok: false; message: string } | { ok: true; value: ParsedStatement }> {
  const broker = String(formData.get("broker") ?? "plantilla").trim();
  if (!isStatementBroker(broker)) {
    return { message: "Selecciona un formato compatible (la plantilla).", ok: false };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { message: "Selecciona un archivo .csv con movimientos.", ok: false };
  }

  const parsed = parseStatement(await file.text(), broker);
  if (!parsed.ok) {
    return { message: parsed.errors[0], ok: false };
  }

  if (parsed.value.rows.length === 0) {
    return {
      message: "El archivo no contiene movimientos finalizados que cargar.",
      ok: false,
    };
  }

  // The per-holding upload is the SECOND statement door (#1401): same plantilla, same
  // reader, its own action. It converts here for the same reason and in the same place
  // as the whole-portfolio one — right after the parse, so the preview counts and the
  // merge plan are computed on the euro figures the confirm will write. Leaving it out
  // would have made this upload the one surviving way to store dollars as euros, and
  // the new `Divisa` column would have made it easier, not harder.
  const converted = await convertStatementRows(parsed.value.rows, fxOptions);
  if (!converted.ok) {
    return { message: mapDomainViolation(converted.violations[0]), ok: false };
  }

  return { ok: true, value: { ...parsed.value, rows: converted.value } };
}

/**
 * Statement preview (ADR 0018, S3 / #176). Parse the uploaded CSV and build the
 * merge plan against this investment's current operations, then return the
 * counts WITHOUT writing anything — the human check before confirm. Reads the
 * store read-only; never redirects (it feeds useActionState).
 */
export async function previewStatementAction(
  routeAssetId: string,
  _prev: StatementPreviewState,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<StatementPreviewState> {
  const _store = testStoreFromActionArgs(_testArgs);
  await guardDemoWrite(currentUrlOf(formData));
  const read = await readStatementFromForm(formData, testFxRatesOverride(_testArgs));
  if (!read.ok) {
    return { message: read.message, status: "error" };
  }

  const { rows, skipped } = read.value;

  return runActionWithStore(async (store) => {
    // ISIN guard (S4): block a wrong-file slip before showing any summary.
    const asset = await store.assets.readInvestmentAssetById(routeAssetId);
    const guard = resolvePerHoldingStatementIsinGuard(read.value, asset?.securityId);
    if (guard.status === "mismatch") {
      return {
        message: isinMismatchMessage(guard.fileIsins, asset?.securityId?.value ?? ""),
        status: "error",
      };
    }

    const plan = planStatementMerge(
      rows,
      await store.operations.readOperations(routeAssetId),
    );
    return {
      anomalies: plan.anomalies.length,
      created: plan.toCreate.length,
      overwritten: plan.toOverwrite.length,
      sells: countSells(plan),
      skipped: skipped.length,
      status: "summary",
    };
  }, _store);
}

/**
 * Statement confirm (ADR 0018, S1 #174 + S2 #175 + S3 #176). Re-validate + parse
 * the uploaded CSV (never trusting the preview), then **merge by date** into the
 * investment's operations (file wins on date overlap, never deletes): a matching
 * date overwrites in place, a new date creates, an operation the file omits is
 * untouched. Apply in one transaction, then run ONE batched historical-snapshot
 * ripple across the union of created + overwritten dates — never per operation
 * (the #158 O(N×snapshots) cliff). The ISIN guard blocks a wrong-file slip and
 * backfills an empty asset (S4); sells load from the plantilla's Operación column.
 */
export async function confirmStatementAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);
  const statementErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, { formId: "statement", message });

  return formAction<
    undefined,
    {
      anomalies: number;
      catalog: ExposureCatalogStubCandidate;
      created: number;
      overwritten: number;
      sells: number;
      skipped: number;
    }
  >({
    // The merge committed — register the holding's (now possibly ISIN-bearing)
    // catalog row so it surfaces in /admin/catalogo. Best-effort (#1097).
    afterCommit: async ({ value }) => {
      await ensureExposureCatalogStubs([value!.catalog]);
      // A statement merge can be the workspace's first holding write (#1131).
      await markFirstHoldingBestEffort();
    },
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) => statementErrorUrl(error),
    onSuccess: ({ value }) =>
      statementLoadedRedirectUrl(returnUrl, {
        anomalies: value!.anomalies,
        created: value!.created,
        overwritten: value!.overwritten,
        sells: value!.sells,
        skipped: value!.skipped,
      }),
    requireId: false,
    run: async (store, { today }) => {
      const read = await readStatementFromForm(formData, testFxRatesOverride(_testArgs));
      if (!read.ok) return { error: read.message, ok: false };

      // ISIN guard (S4): block a mismatch before any write; backfill an empty
      // asset so a later upload to the same holding is guarded too.
      const asset = await store.assets.readInvestmentAssetById(routeAssetId);
      const guard = resolvePerHoldingStatementIsinGuard(read.value, asset?.securityId);
      if (guard.status === "mismatch") {
        return {
          error: isinMismatchMessage(guard.fileIsins, asset?.securityId?.value ?? ""),
          ok: false,
        };
      }
      if (guard.status === "backfill") {
        await store.assets.backfillInvestmentSecurityId(routeAssetId, {
          kind: "isin",
          value: guard.isin,
        });
      }

      // The catalog identity to register once the merge commits (#1097). A
      // statement is the path where an ISIN first attaches to a fund, so this is
      // often the very first identity the holding has. No instrument here:
      // `readInvestmentAssetById` is a market investment by construction and
      // supplies its own provider.
      const catalog: ExposureCatalogStubCandidate = {
        displayName: asset?.name ?? null,
        isin:
          guard.status === "backfill"
            ? guard.isin
            : (storedIsinOrNull(asset?.securityId) ?? null),
        priceProvider: asset?.priceProvider ?? null,
        providerSymbol: asset?.providerSymbol ?? null,
      };

      // Merge by date (S2): plan against the asset's current operations so an
      // overlapping date overwrites in place instead of duplicating, and
      // operations the file does not mention survive untouched. Anomalous dates
      // are set aside.
      const plan = planStatementMerge(
        read.value.rows,
        await store.operations.readOperations(routeAssetId),
      );

      const seed = Date.now();
      // One command persists every create + overwrite AND runs ONE batched ripple
      // over the dates they touch, atomically (ADR 0020 / 0018).
      await store.command.mergeInvestmentOperations({
        assetId: routeAssetId,
        creates: plan.toCreate.map((row, i) =>
          statementRowToCreateInput({
            assetId: routeAssetId,
            id: createStableId("op", `${routeAssetId}_${row.dateKey}`, seed + i),
            row,
            source: "statement",
          }),
        ),
        deletes: plan.toDelete.map((operation) => operation.id),
        overwrites: plan.toOverwrite.map(({ operationId, row }) =>
          statementRowToOverwrite({ operationId, row, source: "statement" }),
        ),
        today,
      });

      return {
        ok: true,
        value: {
          anomalies: plan.anomalies.length,
          catalog,
          created: plan.toCreate.length,
          overwritten: plan.toOverwrite.length,
          sells: countSells(plan),
          skipped: read.value.skipped.length,
        },
      };
    },
  })(formData, ..._testArgs);
}
