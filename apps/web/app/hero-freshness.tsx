import { PriceRefreshControl } from "@web/patrimonio/price-refresh-control";

import { deriveFreshness } from "./freshness";

/**
 * The home hero's freshness stamp + soft update alert (#896, P0-1 front of #783).
 *
 * With the GET cache-only and the daily crons carrying freshness (#895), the home
 * tells the user WHEN the data last updated — in product language, never a
 * technical word (no "cron", no UTC, no "caído"):
 *
 *  - The stamp ("Actualizado hace 15 h") is ALWAYS shown while there is any update
 *    instant; the ≤~12 h normal case never raises a banner.
 *  - Only when the freshest datum outran the automatic window does the gentle
 *    "No pudimos actualizar los datos automáticamente" appear, with an "Actualizar"
 *    action that reuses the existing manual price refresh (#405/#406). That action
 *    is a server action + soft redirect — no full page reload (ADR 0036).
 *
 * Framing-independent, so rendered once outside <FramingPanel> (like the returns
 * line). Renders nothing when there is no update instant yet (empty portfolio).
 */
export default function HeroFreshness({
  updatedAt,
  now,
  refreshAction,
  currentUrl,
}: {
  /** ISO instant of the last successful data update (`latestFetchedAt`), or null. */
  updatedAt: string | null;
  /** ISO "now". */
  now: string;
  /** The manual price-refresh server action (#405/#406). */
  refreshAction: (formData: FormData) => void | Promise<void>;
  /** Where the refresh returns to — the current dashboard URL. */
  currentUrl: string;
}) {
  const freshness = deriveFreshness(updatedAt, now);
  if (!freshness.stampLabel) {
    return null;
  }

  return (
    <div className="heroFreshness">
      {freshness.stale ? (
        <div
          aria-label="Aviso de actualización"
          className="heroFreshnessAlert"
          role="status"
        >
          <p className="heroFreshnessLead">
            No pudimos actualizar los datos automáticamente
          </p>
          <PriceRefreshControl
            action={refreshAction}
            currentUrl={currentUrl}
            label="Actualizar"
            pendingLabel="Actualizando…"
          />
        </div>
      ) : null}
      <p className="heroFreshnessStamp">{freshness.stampLabel}</p>
    </div>
  );
}
