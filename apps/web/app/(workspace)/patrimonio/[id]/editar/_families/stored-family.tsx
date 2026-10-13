/**
 * The `stored` ficha: a holding whose value is what somebody typed — a current
 * account, a term deposit, a vehicle, a metal bar.
 *
 * Since #1846 it is a tabbed ficha. What is done here often is putting the value up
 * to date, so that is the bar's habitual action and its form lives in the side
 * panel, not under the identity form in «Lo básico». The header says the three
 * things a hand-set value needs said beside it: the value — the board row's figure,
 * which this family does not transform (`curve-valued-holdings`); when it was last
 * put up to date, by the SAME reading the `STALE_MANUAL_VALUE` aviso fires on; and
 * when its money can be touched, with the gap of an undeclared term said out loud
 * and a link to where it is declared.
 *
 * Its one tab of its own is Cobros (the interest a deposit pays is an attribution
 * record like any other, PRD #652 S1), placed by the common piece every asset
 * family shares (`ficha-cobros`).
 */

import { holdingWarnings } from "@web/patrimonio/[id]/editar/_chrome/holding-warnings";
import { FichaLink } from "@web/patrimonio/[id]/editar/_ficha/ficha-link";
import {
  FICHA_DATOS_TAB,
  fichaTabUrl,
} from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import { AssetValueForm } from "@web/patrimonio/[id]/editar/_surfaces/asset-value-form";
import { VALUE_FORM_ID } from "@web/patrimonio/action-helpers";
import {
  formatDateKeyEs,
  formatMoneyMinorPrivacy,
  INSTRUMENT_LABELS_ES,
  instrumentOfAsset,
  manualValueFreshness,
} from "@worthline/domain";
import type { ReactNode } from "react";
import type {
  AssetFamilyContext,
  FichaAction,
  FichaFigure,
  HoldingSurface,
} from "./family-contract";
import { holdingSurface } from "./family-contract";
import { COBROS_TAB, fichaCobros } from "./ficha-cobros";
import { availabilityReading, freshnessCaption } from "./stored-header-view";

/** Its own tabs; the page appends «Datos del activo». Cobros opens by default. */
const TABS = [COBROS_TAB] as const;

/** Every tab the ficha ends up with, in order — what each URL here is built against. */
const FICHA_TABS = [...TABS, FICHA_DATOS_TAB] as const;

/** «Actualizar valor»: its `?accion=`. */
const VALUE_ACTION = "valor";

export async function loadStoredSurface(
  ctx: AssetFamilyContext,
): Promise<HoldingSurface> {
  const {
    asset,
    currentUrl,
    formError,
    id,
    isDemo,
    overrides,
    payoutsPanel,
    privacyMode,
  } = ctx;

  // What «Puesto al día» reads, and only for this holding: the same two reads the
  // aviso is built from (`dashboard-data-quality`), one wave.
  const [history, createdAtById] = await Promise.all([
    ctx.store.agentView.readManualValueHistory([id]),
    ctx.store.agentView.readAssetCreatedAtById(),
  ]);
  const freshness = manualValueFreshness(
    history.get(id),
    createdAtById.get(id),
    ctx.today,
  );

  const tabUrl = (tab: (typeof FICHA_TABS)[number]) =>
    fichaTabUrl(currentUrl, FICHA_TABS, tab);
  // The new value and today's date show in the header, on whichever tab: the
  // bare ficha, where it opens.
  const valueUrl = tabUrl(COBROS_TAB);
  const cobros = fichaCobros({ currentUrl, payoutsPanel, tabs: FICHA_TABS });
  const availability = availabilityReading(asset);

  // ── The state header ────────────────────────────────────────────────────────
  const figures: FichaFigure[] = [
    {
      ...(freshness
        ? {
            detail: freshness.stale ? (
              <div className="fichaPriceNotice">
                <span>⚠ {freshnessCaption(freshness)}</span>
              </div>
            ) : (
              <small className="priceRefreshCaption">{freshnessCaption(freshness)}</small>
            ),
            value: formatDateKeyEs(freshness.lastUpdateDateKey),
          }
        : { value: "—" }),
      key: "freshness",
      label: "Puesto al día",
    },
    {
      detail: availabilityDetail(availability, tabUrl(FICHA_DATOS_TAB)),
      key: "availability",
      kind: "text",
      label: "Disponibilidad",
      value: availability.label,
    },
  ];

  // ── The actions, each a form in the side panel ─────────────────────────────
  const actions: FichaAction[] = [
    {
      content: (
        <AssetValueForm
          asset={asset}
          currentUrl={valueUrl}
          formError={formError}
          readOnly={isDemo}
          returnTo={valueUrl}
        />
      ),
      key: VALUE_ACTION,
      label: "Actualizar valor",
      tier: "primary",
    },
    cobros.action,
  ];

  return holdingSurface("stored", {
    ficha: {
      actions,
      errorTargets: {
        ...cobros.errorTargets,
        // A refused value reopens its panel, with what was typed (#1846).
        [VALUE_FORM_ID]: { action: VALUE_ACTION },
      },
      figures,
      instrument: INSTRUMENT_LABELS_ES[instrumentOfAsset(asset)],
      // «Actualizar valor» prints its own refusal, in its panel (#1846).
      ownErrorForms: [VALUE_FORM_ID],
      rows: payoutsPanel.rows,
      tabs: [cobros.tab],
      // The board row's figure, untransformed, in the holding's own currency.
      value: formatMoneyMinorPrivacy(asset.currentValue, privacyMode),
      // No ledger: the band's warnings are about the holding's own row.
      warnings: holdingWarnings({ asset, id, operations: [], overrides }),
    },
  });
}

/** What qualifies «Disponibilidad»: its term, or the gap where one is missing. */
function availabilityDetail(
  reading: ReturnType<typeof availabilityReading>,
  datosUrl: string,
): ReactNode {
  switch (reading.kind) {
    case "since":
      return <small className="priceRefreshCaption">desde {reading.since}</small>;
    case "lots":
      return <small className="priceRefreshCaption">por lotes de aportación</small>;
    case "undeclared":
      // Said here, not only inside «Datos»: an undeclared term is counted as money
      // available from year one, and whoever does not know cannot fix it (ADR 0100).
      return (
        <div className="fichaPriceNotice">
          <span>Sin fecha declarada</span>
          <span aria-hidden="true">·</span>
          <FichaLink field="availableFrom" href={datosUrl} tab={FICHA_DATOS_TAB}>
            Declarar fecha
          </FichaLink>
        </div>
      );
    default:
      return null;
  }
}
