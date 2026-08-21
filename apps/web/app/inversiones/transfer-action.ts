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
  NEW_DESTINATION,
  parseTransferForm,
  previewTransfer,
  readTransferFormValues,
  TRANSFER_FORM_FIELDS,
  type TransferDestination,
  type TransferDraft,
} from "@web/patrimonio/[id]/editar/_surfaces/transfer-form";
import type { WorthlineStore } from "@web/store";
import type {
  CurrencyCode,
  DecimalString,
  Instrument,
  ManualAsset,
} from "@worthline/domain";
import { defaultsFor, derivePosition, operationsUpTo } from "@worthline/domain";

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

  return formAction<TransferDraft, { newDestination: TransferDestination | null }>({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) => transferErrorUrl(error),
    onSuccess: () => successRedirectUrl(returnUrl, "transfer_recorded"),
    parse: ({ today }) => {
      const parsed = parseTransferForm(values, today);
      return parsed.ok
        ? { ok: true, value: parsed.command }
        : { ok: false, redirect: transferErrorUrl(parsed.error) };
    },
    requireId: false,
    run: async (store, { parsed, today }) => {
      const origin = (await store.assets.readAssets()).find(
        (asset) => asset.id === originAssetId,
      );
      if (!origin) {
        return { ok: false, error: "Esa inversión ya no está en tu patrimonio." };
      }

      const outOperationId = createStableId("op", `${originAssetId}_transfer_out`, seed);

      // The replay shortcut (#1394) comes FIRST, before any figure is judged. A
      // replay looks at a ledger that already holds the traspaso, so the position it
      // would be measured against is the one AFTER it left — and the very same
      // importe would then be refused as exceeding it. The pair's own row is what
      // tells a second submit ("my traspaso is already there") from a first one; the
      // gate's ids are primary keys, so a race that gets past this still collides
      // rather than writing twice.
      const alreadyRecorded = (await store.operations.readOperations(originAssetId)).some(
        (operation) => operation.id === outOperationId,
      );
      if (alreadyRecorded) {
        return { ok: true, value: { newDestination: null } };
      }

      // Check the figures BEFORE creating anything. The gate would refuse them too —
      // it is the authority — but by then a brand-new destination holding would
      // already be in the book, empty, for a traspaso that never happened.
      const refusal = await refuseUpFront(store, {
        assetId: originAssetId,
        currency: origin.currency,
        dateKey: parsed.executedAt,
        today,
        values,
      });
      if (refusal) return { ok: false, error: refusal };

      const destination = await resolveDestination(store, {
        destination: parsed.destination,
        origin,
        pricePerUnit: parsed.destinationPricePerUnit,
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

      return {
        ok: true,
        value: { newDestination: destination.created ? parsed.destination : null },
      };
    },
    // The just-created destination's identity joins the exposure catalog (#1097), so
    // its row is born with the holding instead of waiting for a backfill. Best
    // effort by construction: a catalog that is down must not undo a written
    // traspaso.
    afterCommit: async ({ value }) => {
      const created = value?.newDestination;
      if (!created || created.kind !== "new") return;

      await ensureExposureCatalogStubs([
        {
          displayName: created.name,
          instrument: null,
          isin: created.isin ?? null,
          priceProvider: null,
          providerSymbol: null,
        },
      ]);
    },
  })(formData, ..._testArgs);
}

/**
 * The refusal the gate would answer with, computed from the origin's ledger before
 * anything is written — or null when the figures pass.
 *
 * Runs `previewTransfer`, the same function the screen prints under the fields, so
 * this check can never disagree with either the form or the writer (#1438).
 */
async function refuseUpFront(
  store: WorthlineStore,
  params: {
    assetId: string;
    currency: CurrencyCode;
    dateKey: string;
    today: string;
    values: Parameters<typeof previewTransfer>[0];
  },
): Promise<string | null> {
  const operations = await store.operations.readOperations(params.assetId);
  const position = derivePosition(operationsUpTo(operations, params.dateKey), {
    assetId: params.assetId,
    currency: params.currency,
  });

  const preview = previewTransfer(
    params.values,
    {
      assetId: params.assetId,
      costBasisMinor: position.costBasis.amountMinor,
      unitsHeld: position.currentUnits,
    },
    params.today,
  );

  return preview.status === "refused" ? preview.message : null;
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
): Promise<{ assetId: string; created: boolean }> {
  if (params.destination.kind === "existing") {
    return { assetId: params.destination.assetId, created: false };
  }

  const id = createStableId("asset", params.destination.name, params.seed);

  // A replayed submit mints the same id, so the holding it already created is found
  // here rather than duplicated under a second one.
  const existing = (await store.assets.readAssets()).some((asset) => asset.id === id);
  if (existing) {
    return { assetId: id, created: false };
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

  return { assetId: id, created: true };
}
