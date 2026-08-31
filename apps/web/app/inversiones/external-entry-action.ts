"use server";

import { formAction } from "@web/form-action";
import {
  createStableId,
  errorRedirectUrl,
  mapDomainViolation,
  parseSubmissionId,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import {
  EXTERNAL_ENTRY_FORM_FIELDS,
  readExternalEntryFormValues,
} from "@web/patrimonio/[id]/editar/_surfaces/external-entry-form";
import { resolveExternalTransferCapture } from "@web/patrimonio/anadir/external-transfer-in";

/**
 * The «Traer de otra entidad» server action (#1518): a movilización that lands on a
 * holding this book ALREADY keeps.
 *
 * Why it exists next to the alta's door (#1541). That one records an external entry
 * as part of CREATING the holding, which is the first movilización and nothing else.
 * The second one — Jorge consolidating another plan into the same MyInvestor PP — had
 * no door at all: the only shapes reachable from the ficha were a `buy`, which eats a
 * year of contribution allowance for capital that merely moved (ADR 0080), and the
 * «Traspasar» screen, which demands an origin holding that by definition is not here.
 * The engine has accepted a `destinationAssetId` since #1479; this is the missing
 * product path onto it.
 *
 * What it owns beyond forwarding to the gate:
 *
 * - **Idempotency (#1394).** The row's id and its own `transferId` are seeded off the
 *   client's submission key, so a double click resolves to the same ids and the
 *   second write collides with the first instead of booking the capital twice.
 *   Without JS the seed is the clock, as everywhere else.
 * - **Refusals are form messages.** Every figure is judged by
 *   `planExternalTransferIn` — through the same pure capture the pane previews with —
 *   so a VL of zero or a seniority dated after the entry comes back beside the field,
 *   never as a 500.
 *
 * The arithmetic is not here and must never be: it is `planExternalTransferIn`,
 * behind the gate, and the same function the section previews with.
 */
export async function recordExternalEntryAction(
  destinationAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const submissionId = parseSubmissionId(formData);
  // The `k` prefix keeps the two seed spaces disjoint, exactly as in the traspaso
  // action: a key that reads as digits can never land on the id the no-JS path would
  // mint at that millisecond.
  const seed: number | string = submissionId ? `k${submissionId}` : Date.now();
  const returnUrl = (formData.get("currentUrl") as string) || "/patrimonio";
  const values = readExternalEntryFormValues(formData);

  return formAction<undefined, undefined>({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) =>
      errorRedirectUrl(returnUrl, {
        formId: "externalEntry",
        message: error,
        values: preserveFields(formData, [...EXTERNAL_ENTRY_FORM_FIELDS]),
      }),
    onSuccess: () => successRedirectUrl(returnUrl, "external_entry_recorded"),
    requireId: false,
    run: async (store, { today }) => {
      const capture = resolveExternalTransferCapture({ ...values, today });
      if (!capture.ok) {
        return { error: capture.error, ok: false };
      }

      const inOperationId = createStableId(
        "op",
        `${destinationAssetId}_external_in`,
        seed,
      );

      // The replay shortcut (#1394): a second submit finds its own row already
      // written and stops, rather than adding the same movilización twice. Unlike
      // the traspaso's, no position is measured against, so this is a courtesy on
      // top of the primary-key collision the gate would raise anyway.
      const operations = await store.operations.readOperations(destinationAssetId);
      if (operations.some((operation) => operation.id === inOperationId)) {
        return { ok: true, value: undefined };
      }

      const result = await store.command.recordExternalTransferIn({
        amountMinor: capture.amountMinor,
        destinationAssetId,
        destinationPricePerUnit: capture.pricePerUnit,
        executedAt: capture.executedAt,
        inheritedCostMinor: capture.inheritedCostMinor,
        inOperationId,
        today,
        transferId: createStableId("trf", `${destinationAssetId}_external`, seed),
        ...(capture.seniorityAt === undefined
          ? {}
          : { seniorityAt: capture.seniorityAt }),
      });

      if (!result.ok) {
        return { error: mapDomainViolation(result.violations[0]), ok: false };
      }

      return { ok: true, value: undefined };
    },
  })(formData, ..._testArgs);
}
