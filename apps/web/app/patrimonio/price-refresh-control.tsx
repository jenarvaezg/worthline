import { PendingSubmit } from "@web/pending-submit";

/**
 * On-demand "Actualizar precios" trigger (#405) and its single-holding variant
 * (#406). Posts to the parked `refreshPricesAction` (ADR 0026, #317), which
 * force-refetches every priced holding from its provider and redirects with the
 * `prices_refreshed` outcome the surrounding page already surfaces.
 *
 * `assetId` scopes the refresh to one holding's ficha; omitting it refreshes the
 * whole portfolio from /patrimonio. The action reads both hidden fields from the
 * submitted FormData. Pending/disabled feedback comes from `PendingSubmit`.
 */
export function PriceRefreshControl({
  action,
  currentUrl,
  assetId,
  label,
  pendingLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  currentUrl: string;
  /** When set, the action refreshes only this holding (#406). */
  assetId?: string;
  label: string;
  pendingLabel: string;
}) {
  return (
    <form action={action} className="priceRefreshForm">
      <input name="currentUrl" type="hidden" value={currentUrl} />
      {assetId ? <input name="assetId" type="hidden" value={assetId} /> : null}
      <PendingSubmit pendingLabel={pendingLabel}>{label}</PendingSubmit>
    </form>
  );
}
