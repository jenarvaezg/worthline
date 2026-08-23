"use server";

import { ensureExposureCatalogStubs } from "@web/ensure-exposure-catalog-stubs";
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
  parseTransferForm,
  previewTransfer,
  readTransferFormValues,
  TRANSFER_FORM_FIELDS,
  type TransferDestination,
  type TransferDraft,
} from "@web/patrimonio/[id]/editar/_surfaces/transfer-form";
import type { WorthlineStore } from "@web/store";
import type { DecimalString, Instrument, ManualAsset } from "@worthline/domain";
import {
  defaultsFor,
  netUnitsFromOperations,
  unitsReadAsClosed,
} from "@worthline/domain";

/** A destination this submit created, as the exposure catalog wants to hear it. */
interface CreatedDestination {
  name: string;
  instrument: Instrument;
  isin?: string;
}

/**
 * The «Traspasar» server action (#1480, S3 of PRD #1393): one screen, one submit.
 *
 * What it owns beyond forwarding to the gate:
 *
 * - **The destination may not exist yet.** A traspaso to a plan the user has just
 *   opened is the ordinary case — Jorge did it three times in 2026 — and sending
 *   them to «Añadir holding» first would lose the form they had half filled in. So
 *   the holding is created HERE, from the two things the flow already knows (the
 *   origin's instrument and its owners: the capital only moved) plus a name and an
 *   optional ISIN. It is created only after the figures have been checked, so a
 *   refused traspaso never leaves an empty holding behind.
 * - **Idempotency (#1394).** The three ids — the pair's `transferId`, both operation
 *   ids and, for a new destination, the holding's own id — are seeded off the
 *   client's submission key, so a double click resolves to the same ids, finds its
 *   own rows already written and does nothing. Without JS the seed is the clock, as
 *   everywhere else.
 * - **Refusals are form messages.** The gate answers a bad figure with a
 *   `DomainResult`, so an importe above the position comes back beside the field
 *   that produced it (naming both unit counts and offering «todo»), never as a 500.
 *
 * The arithmetic is not here and must never be: it is `planTransfer`, behind the
 * gate, and the same function the screen previews with (`transfer-form.ts`).
 */
export async function recordTransferAction(
  originAssetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
) {
  const submissionId = parseSubmissionId(formData);
  // The `k` prefix keeps the two seed spaces disjoint: a key that reads as digits
  // can never land on the id the no-JS path would mint at that millisecond.
  const seed: number | string = submissionId ? `k${submissionId}` : Date.now();
  const returnUrl = (formData.get("currentUrl") as string) || "/patrimonio";
  const values = readTransferFormValues(formData);

  const transferErrorUrl = (message: string) =>
    errorRedirectUrl(returnUrl, {
      formId: "transfer",
      message,
      values: preserveFields(formData, [...TRANSFER_FORM_FIELDS]),
    });

  return formAction<
    TransferDraft,
    { created: CreatedDestination | null; originTrashed: boolean }
  >({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) => transferErrorUrl(error),
    onSuccess: ({ value }) =>
      successRedirectUrl(
        returnUrl,
        value?.originTrashed ? "transfer_recorded_origin_trashed" : "transfer_recorded",
      ),
    parse: ({ today }) => {
      const parsed = parseTransferForm(values, today);
      return parsed.ok
        ? { ok: true, value: parsed.command }
        : { ok: false, redirect: transferErrorUrl(parsed.error) };
    },
    requireId: false,
    run: async (store, { now, parsed, today }) => {
      const origin = (await store.assets.readAssets()).find(
        (asset) => asset.id === originAssetId,
      );
      if (!origin) {
        return { ok: false, error: "Esa inversión ya no está en tu patrimonio." };
      }

      const outOperationId = createStableId("op", `${originAssetId}_transfer_out`, seed);
      const operations = await store.operations.readOperations(originAssetId);

      // The replay shortcut (#1394) comes FIRST, before any figure is judged. A
      // replay looks at a ledger that already holds the traspaso, so the position it
      // would be measured against is the one AFTER it left — and the very same
      // importe would then be refused as exceeding it. The pair's own row is what
      // tells a second submit ("my traspaso is already there") from a first one; the
      // gate's ids are primary keys, so a race that gets past this still collides
      // rather than writing twice.
      if (operations.some((operation) => operation.id === outOperationId)) {
        return { ok: true, value: { created: null, originTrashed: false } };
      }

      // Check the figures BEFORE creating anything, with the function the SCREEN
      // previews with — which is `planTransfer`, the gate's own arithmetic, over the
      // ledger folded at the transfer date. The gate would refuse them too (it is the
      // authority), but by then a brand-new destination holding would already be in
      // the book, empty, for a traspaso that never happened.
      const preview = previewTransfer(
        values,
        { assetId: originAssetId, currency: origin.currency, operations },
        today,
      );
      if (preview.status !== "ready") {
        // `incomplete` cannot happen here — the same parse already succeeded above, and
        // it is the only thing that produces it — but the preview is where the
        // destination's VL comes from, so this narrows instead of asserting.
        return {
          ok: false,
          error:
            preview.status === "refused"
              ? preview.message
              : "Faltan datos del traspaso — revisa el importe y las participaciones.",
        };
      }

      const destination = await resolveDestination(store, {
        destination: parsed.destination,
        origin,
        // The VL a brand-new destination is born priced at is the one the pair will be
        // WRITTEN at — which in the `units` reading is derived, not typed (#1544).
        pricePerUnit: preview.inPricePerUnit,
        seed,
      });

      const inOperationId = createStableId(
        "op",
        `${destination.assetId}_transfer_in`,
        seed,
      );

      const result = await store.command.recordInvestmentTransfer({
        destinationAssetId: destination.assetId,
        destinationPricePerUnit: parsed.destinationPricePerUnit,
        destinationUnits: parsed.destinationUnits,
        executedAt: parsed.executedAt,
        inOperationId,
        originAssetId,
        originPricePerUnit: parsed.originPricePerUnit,
        outOperationId,
        portion: parsed.portion,
        today,
        transferId: createStableId("trf", originAssetId, seed),
        ...(parsed.destinationAmountMinor === undefined
          ? {}
          : { destinationAmountMinor: parsed.destinationAmountMinor }),
      });

      if (!result.ok) {
        return { ok: false, error: mapDomainViolation(result.violations[0]) };
      }

      const originTrashed = await archiveOriginIfAsked(store, {
        archive: formData.get("archiveOrigin") === "1",
        now,
        originAssetId,
      });

      return { ok: true, value: { created: destination.created, originTrashed } };
    },
    // The just-created destination's identity joins the exposure catalog (#1097), so
    // its row is born with the holding instead of waiting for a backfill. Best
    // effort by construction: a catalog that is down must not undo a written
    // traspaso.
    afterCommit: async ({ value }) => {
      const created = value?.created;
      if (!created) return;

      await ensureExposureCatalogStubs([
        {
          displayName: created.name,
          // The instrument is known here (inherited from the origin), so the catalog
          // row is born with its provenance rather than blank (#1097/#1508).
          instrument: created.instrument,
          isin: created.isin ?? null,
          priceProvider: null,
          providerSymbol: null,
        },
      ]);
    },
  })(formData, ..._testArgs);
}

/**
 * The Papelera's «Lo traspasé a…» exit, closing (#1549): the origin follows its
 * money out of the book, in the same gesture that recorded where the money went.
 *
 * Conditional on the ledger, never on the intent: the archive happens only if the
 * traspaso actually emptied the origin. A partial traspaso leaves a real position
 * behind, and archiving THAT would be the very evaporation the door exists to
 * prevent — so the gate in `softDeleteAsset` would refuse it anyway, and the
 * traspaso (already written, already rippled) is not undone for it. The user lands
 * on a ficha whose position is smaller and whose danger zone still asks its
 * question.
 *
 * Returns whether the origin was actually archived, because the promise the banner
 * made ("se irá a la Papelera si el traspaso lo deja sin participaciones") has two
 * outcomes and the user must be told which one happened — a refusal or a partial
 * traspaso would otherwise read exactly like a success.
 */
async function archiveOriginIfAsked(
  store: WorthlineStore,
  params: { archive: boolean; now: string; originAssetId: string },
): Promise<boolean> {
  if (!params.archive) return false;

  const remaining = netUnitsFromOperations(
    await store.operations.readOperations(params.originAssetId),
  );
  if (!unitsReadAsClosed(remaining)) return false;

  const outcome = await store.assets.softDeleteAsset(
    params.originAssetId,
    params.now,
    "transferred",
  );
  return outcome.status === "deleted";
}

/**
 * The destination's id — an existing holding's, or a newly created one's.
 *
 * A created holding inherits what the traspaso already implies: the origin's
 * instrument (a plan is traspasado to a plan), its currency and its owners, because
 * the same capital is on both sides. Its declared VL becomes its manual price: no
 * provider will ever quote a hand-created plan, and without a price the holding
 * would land in the list worth 0 € (#1490's lesson, one door earlier).
 */
async function resolveDestination(
  store: WorthlineStore,
  params: {
    destination: TransferDestination;
    origin: ManualAsset;
    pricePerUnit: DecimalString;
    seed: number | string;
  },
): Promise<{ assetId: string; created: CreatedDestination | null }> {
  if (params.destination.kind === "existing") {
    return { assetId: params.destination.assetId, created: null };
  }

  const id = createStableId("asset", params.destination.name, params.seed);

  // A replayed submit mints the same id, so the holding it already created is found
  // here rather than duplicated under a second one.
  const existing = (await store.assets.readAssets()).some((asset) => asset.id === id);
  if (existing) {
    return { assetId: id, created: null };
  }

  const instrument: Instrument = params.origin.instrument ?? "fund";

  await store.assets.createInvestmentAsset({
    currency: params.origin.currency,
    id,
    instrument,
    liquidityTier: defaultsFor(instrument).rung,
    manualPricePerUnit: params.pricePerUnit,
    name: params.destination.name,
    ownership: params.origin.ownership,
    ...(params.destination.isin ? { isin: params.destination.isin } : {}),
  });

  return {
    assetId: id,
    created: {
      instrument,
      name: params.destination.name,
      ...(params.destination.isin ? { isin: params.destination.isin } : {}),
    },
  };
}
