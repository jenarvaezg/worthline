"use server";

/**
 * The investment operations ledger — record and delete (ADR 0006/0014/0020).
 *
 * The CRUD of what the holding *did*: one apunte in, one apunte out. Everything
 * that merely reads or re-prices the holding (extracto, cobros, precios,
 * corrección de snapshot) lives in its own module beside this one (#1606).
 */

import { runActionWithStore, testFxRatesOverride } from "@web/action-store";
import { formAction, formActionInlineError } from "@web/form-action";
import {
  errorRedirectUrl,
  mapDomainViolation,
  parseRouteOperationCommand,
  parseSubmissionId,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import { currentUrlOf } from "@web/inversiones/return-url";
import type { CreateInvestmentOperationInput } from "@worthline/domain";
import {
  compareUnits,
  createInvestmentOperationSafe,
  netUnitsFromOperations,
  oversellConfirmMessage,
} from "@worthline/domain";
import { convertCapturedOperation } from "@worthline/pricing";

// Field list for the error-preserve round-trip.
//
// `currency` rides along (#1401): a rejected capture that came back without it would
// re-open the form in EUR, and the user would re-pick the same currency every attempt
// — the same round-trip lesson as the #1329 acknowledgement in the edit form.
const OPERATION_FORM_FIELDS = [
  "kind",
  "executedAt",
  "units",
  "pricePerUnit",
  "fees",
  "currency",
  "oversellConfirmed",
  "oversellPending",
];

/**
 * Record one investment operation (ADR 0006/0014/0020).
 *
 * Idempotent when the form carries a `submissionId` (#1394). A double click once
 * left the father with two identical sells 4 seconds apart and ~1.000 € of net
 * worth gone — and, because the operation was backdated, every snapshot from that
 * date on was rewritten with the wrong units. The client sends one key per
 * submission and the key SEEDS the operation id, so a replay of the same
 * submission resolves to the same id, finds its own row already there, and writes
 * nothing. Two legitimately identical operations (a split periodic buy) arrive
 * under different keys and both persist. Without the key — the no-JS path — the
 * id is still seeded off the clock and nothing changes.
 */
export async function recordOperationAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const submissionId = parseSubmissionId(formData);
  const returnUrl = currentUrlOf(formData);
  // Re-express a non-EUR apunte in euros at the rate of its execution date (#1401).
  // The ledger sums ONE currency, so this is the last thing that happens before the
  // write and the first thing that can refuse it. A EUR apunte short-circuits inside
  // `convertCapturedOperation` without touching the network.
  const convertCapture = async (
    parsed: CreateInvestmentOperationInput,
  ): Promise<
    { ok: true; value: CreateInvestmentOperationInput } | { ok: false; error: string }
  > => {
    const converted = await convertCapturedOperation(
      parsed,
      testFxRatesOverride(_testArgs),
    );
    return converted.ok
      ? { ok: true, value: converted.value }
      : { ok: false, error: mapDomainViolation(converted.violations[0]) };
  };
  const operationErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "operation",
      message,
      values: preserveFields(formData, OPERATION_FORM_FIELDS),
    });

  // The refused submit's own fields, so the form refills itself without the
  // values ever riding a URL. Read AFTER `run` may have stamped a marker on the
  // body (`oversellPending`), exactly as `operationErrorUrl` did.
  const operationErrorValues = () => preserveFields(formData, OPERATION_FORM_FIELDS);

  // Split terminal (#1311): the rejection comes back as state when the submit
  // asked for it, so the reason can never be lost with the navigation that used
  // to carry it. Success still redirects; a form posted with JS off still gets
  // `operationErrorUrl`.
  return formActionInlineError({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) => ({ error, values: operationErrorValues() }),
    onErrorUrl: ({ error }) => operationErrorUrl(error),
    onSuccess: () => successRedirectUrl(returnUrl, "saved"),
    parse: ({ today }) => {
      const parsed = parseRouteOperationCommand(
        formData,
        routeAssetId,
        // The `k` prefix keeps the two seed spaces disjoint by construction: a
        // key that happens to read as digits can never land on the id the no-JS
        // path would mint at that millisecond.
        submissionId ? `k${submissionId}` : Date.now(),
        today,
      );
      if (!parsed.ok) return { ok: false, error: parsed.error };

      const domainResult = createInvestmentOperationSafe(parsed.command);
      if (!domainResult.ok) {
        return { ok: false, error: mapDomainViolation(domainResult.violations[0]) };
      }
      return { ok: true, value: domainResult.value };
    },
    requireId: false,
    // One command persists the operation AND ripples its snapshots atomically
    // (ADR 0020; backdated operation → reconstruct history, PRD #107).
    run: async (store, { parsed, today }) => {
      if (parsed.kind === "sell") {
        const held = netUnitsFromOperations(
          await store.operations.readOperations(routeAssetId),
        );
        if (
          compareUnits(parsed.units, held) > 0 &&
          formData.get("oversellConfirmed") !== "1"
        ) {
          formData.set("oversellPending", "1");
          return { error: oversellConfirmMessage(held, parsed.units), ok: false };
        }
      }

      // The no-JS path has no dedupe key: clock-seeded id, single write, exactly
      // as before.
      if (!submissionId) {
        const converted = await convertCapture(parsed);
        if (!converted.ok) return { ok: false, error: converted.error };
        await store.command.recordInvestmentOperation(converted.value, { today });
        return { ok: true };
      }

      // The keyed path (#1394). The id IS the dedupe key, and the row's primary
      // key is what ultimately enforces it — the read below is only the cheap
      // shortcut for the ordinary replay (Next serializes a client's actions, so
      // the double click arrives second). Two replicas that are NOT serialized —
      // two tabs, two devices, a browser retrying over a second connection —
      // both read before either writes, and the loser's INSERT hits the id's
      // UNIQUE constraint. Asking the ledger again is what tells a replica
      // ("my row is there, someone else wrote it") apart from a genuine failure
      // ("nothing was written"): the first is the success this action promises,
      // the second still surfaces. `datedFact: false` means nothing else
      // translates that constraint, so an unhandled collision would be a raw 500.
      const alreadyRecorded = async () =>
        (await store.operations.readOperations(routeAssetId)).some(
          (operation) => operation.id === parsed.id,
        );

      if (await alreadyRecorded()) return { ok: true };

      // Converted AFTER the replay shortcut, so a double click never spends a second
      // ECB request on an operation that is already in the ledger.
      const converted = await convertCapture(parsed);
      if (!converted.ok) return { ok: false, error: converted.error };

      try {
        await store.command.recordInvestmentOperation(converted.value, { today });
      } catch (error) {
        if (await alreadyRecorded()) return { ok: true };
        throw error;
      }
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

export async function deleteOperationAction(
  routeAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const returnUrl = currentUrlOf(formData);

  return formAction({
    datedFact: false,
    extraIds: ["operationId"],
    guardUrl: () => returnUrl,
    missingId: "Identificador de operación no encontrado.",
    missingIdUrl: () => returnUrl,
    onError: ({ error }) => errorRedirectUrl(returnUrl, { message: error }),
    onSuccess: () => successRedirectUrl(returnUrl, "operation_deleted"),
    requireId: false,
    // One command deletes the operation AND ripples snapshots ≥ its date,
    // atomically (ADR 0020; deleting a backdated operation, PRD #107).
    run: async (store, { extra, today }) => {
      const operationId = extra.operationId!;

      // Half a traspaso is not a deletable unit (#1479): the row the button points at
      // is one of a pair, so what the click means is «deshaz el traspaso». The store
      // refuses the row-at-a-time delete outright, and this is where the intent is
      // translated — into the pair's own command, which removes both rows and ripples
      // both holdings in one transaction.
      const transferId = await store.operations.readTransferIdOf(operationId);

      if (transferId !== null) {
        const removed = await store.command.deleteInvestmentTransfer({
          transferId,
          today,
        });
        return removed.length > 0
          ? { ok: true }
          : {
              error: "No se encontró el traspaso — puede que ya se haya eliminado.",
              ok: false,
            };
      }

      const deleted = await store.command.deleteInvestmentOperation({
        operationId,
        today,
      });
      if (!deleted) {
        return {
          error: "No se encontró la operación — puede que ya se haya eliminado.",
          ok: false,
        };
      }
      return { ok: true };
    },
  })(formData, ..._testArgs);
}
