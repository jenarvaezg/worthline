/**
 * The `appreciating` housing ficha (PRD #108, #1441) — a tabbed one since #1847.
 *
 * Four reads, one wave (#446): the market appraisals that anchor the curve, the
 * appreciation rate that draws it between them, the cadence that decides its
 * shape (ADR 0031, #394; null reads as `step`), and the acquisition cost — the
 * property's OTHER number, never a point on its curve, and the only housing
 * write that ripples nothing.
 *
 * What is done here often is registering an appraisal, so that is the bar's
 * habitual action and its form lives in the side panel. «Actualizar valor» is not
 * offered at all: on a property it wrote a market appraisal dated today — the same
 * fact as «Registrar tasación», through a second door — so the panel is the one
 * door here and the «puesta al día» keeps its own.
 *
 * The header's value is the board row's, from the same calculation: the curve on
 * today (`housingValueToday`, the read `load-patrimonio` values its rows with), not
 * the stored column, which is only the curve's fallback basis. «Resultado frente al
 * coste» is measured against that same value, in the header and in the tab.
 *
 * Its tabs are Cobros and «Valoración». A rented flat's payouts are what the user
 * comes to this ficha for, so once it has any Cobros goes first and opens by
 * default; one that never paid anything opens on its valuation — the same
 * threshold that brings «Añadir cobro» to the bar (#1829).
 */

import { holdingWarnings } from "@web/patrimonio/[id]/editar/_chrome/holding-warnings";
import { FichaLink } from "@web/patrimonio/[id]/editar/_ficha/ficha-link";
import {
  FICHA_DATOS_TAB,
  fichaActionUrl,
  fichaTabUrl,
} from "@web/patrimonio/[id]/editar/_ficha/ficha-view";
import { AcquisitionCostSection } from "@web/patrimonio/[id]/editar/_surfaces/acquisition-cost-section";
import {
  ANCHOR_FORM_ID,
  AnchorAddForm,
  HousingValuationSection,
} from "@web/patrimonio/[id]/editar/_surfaces/housing-valuation-section";
import {
  anchorKindLabel,
  housingValueToday,
  latestAnchor,
  rateToPercentInput,
  resultAgainstCost,
} from "@web/patrimonio/[id]/editar/_surfaces/housing-valuation-view";
import type { MoneyMinor } from "@worthline/domain";
import {
  formatDateKeyEs,
  formatMoneyMinorPrivacy,
  INSTRUMENT_LABELS_ES,
  instrumentOfAsset,
  moneySign,
} from "@worthline/domain";
import type {
  AssetFamilyContext,
  FichaAction,
  FichaFigure,
  HoldingSurface,
} from "./family-contract";
import { holdingSurface } from "./family-contract";
import { COBROS_TAB, fichaCobros } from "./ficha-cobros";

/** «Valoración»: the curve, its anchors and the acquisition cost. */
export const VALORACION_TAB = "valoracion";

/** «Registrar tasación»: its `?accion=`. */
export const TASACION_ACTION = "tasacion";

export async function loadHousingSurface(
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
    store,
    today,
  } = ctx;

  const [anchors, appreciationRate, valuationCadence, acquisitionCostMinor] =
    await Promise.all([
      store.assets.readValuationAnchors(id),
      store.assets.readAnnualAppreciationRate(id),
      store.assets.readValuationCadence(id),
      store.assets.readAcquisitionCostMinor(id),
    ]);

  // Every tab the ficha ends up with, in order — what each URL here is built
  // against. Cobros first once the flat has paid something (#1829's threshold).
  const ownTabs =
    payoutsPanel.count > 0
      ? ([COBROS_TAB, VALORACION_TAB] as const)
      : ([VALORACION_TAB, COBROS_TAB] as const);
  const fichaTabs = [...ownTabs, FICHA_DATOS_TAB] as const;
  const valoracionUrl = fichaTabUrl(currentUrl, fichaTabs, VALORACION_TAB);
  const cobros = fichaCobros({ currentUrl, payoutsPanel, tabs: fichaTabs });

  // The board row's figure, from the same calculation (`load-patrimonio`).
  const value: MoneyMinor = {
    amountMinor: housingValueToday({
      anchors,
      appreciationRate,
      cadence: valuationCadence,
      currentValueMinor: asset.currentValue.amountMinor,
      today,
    }),
    currency: asset.currentValue.currency,
  };
  const money = (amountMinor: number) =>
    formatMoneyMinorPrivacy({ amountMinor, currency: value.currency }, privacyMode);
  const result = resultAgainstCost(acquisitionCostMinor, value);

  // ── The state header ────────────────────────────────────────────────────────
  const latest = latestAnchor(anchors, today);
  const ratePercent = rateToPercentInput(appreciationRate);
  const rateLink = (words: string) => (
    <FichaLink field="rate" href={valoracionUrl} tab={VALORACION_TAB}>
      {words}
    </FichaLink>
  );

  const figures: FichaFigure[] = [
    latest
      ? {
          detail: (
            <small className="priceRefreshCaption">
              {anchorKindLabel(latest)} · {formatDateKeyEs(latest.valuationDate)}
            </small>
          ),
          key: "latest",
          label: "Última tasación",
          value: money(latest.valueMinor),
        }
      : {
          key: "latest",
          kind: "text",
          label: "Última tasación",
          value: "Sin tasaciones",
        },
    ratePercent === ""
      ? {
          detail: (
            <small className="priceRefreshCaption">{rateLink("Indicar tasa")}</small>
          ),
          key: "rate",
          kind: "text",
          label: "Revalorización anual",
          value: "Sin revalorización",
        }
      : {
          detail: (
            <small className="priceRefreshCaption">{rateLink("Cambiar tasa")}</small>
          ),
          key: "rate",
          label: "Revalorización anual",
          value: `${ratePercent.replace(".", ",")} %`,
        },
    resultFigure(),
  ];

  function resultFigure(): FichaFigure {
    const label = "Resultado frente al coste";
    if (result !== null) {
      const sign = moneySign(result);
      return {
        key: "result",
        label,
        // A movement, so it carries its sign in the text and in the hue (canon §6).
        ...(sign === "zero" ? {} : { tone: sign }),
        value: `${result.amountMinor > 0 ? "+" : ""}${money(result.amountMinor)}`,
      };
    }
    if (acquisitionCostMinor !== null) return { key: "result", label, value: "—" };
    // Said here, not only inside «Valoración»: with no cost there is no result, and
    // whoever does not know that cannot fix it.
    return {
      detail: (
        <div className="fichaPriceNotice">
          <span>Sin coste declarado</span>
          <span aria-hidden="true">·</span>
          <FichaLink field="acquisitionCost" href={valoracionUrl} tab={VALORACION_TAB}>
            Indicar coste
          </FichaLink>
        </div>
      ),
      key: "result",
      label,
      value: "—",
    };
  }

  // ── The actions, each a form in the side panel ─────────────────────────────
  const actions: FichaAction[] = [
    {
      content: (
        <AnchorAddForm
          assetId={asset.id}
          currentUrl={valoracionUrl}
          formError={formError}
          readOnly={isDemo}
          today={today}
        />
      ),
      key: TASACION_ACTION,
      label: "Registrar tasación",
      tier: "primary",
    },
    cobros.action,
  ];

  // ── The tabs ────────────────────────────────────────────────────────────────
  const valoracion = {
    content: (
      <>
        <HousingValuationSection
          addLink={
            <FichaLink
              action={TASACION_ACTION}
              href={fichaActionUrl(
                currentUrl,
                fichaTabs,
                VALORACION_TAB,
                TASACION_ACTION,
              )}
              tab={VALORACION_TAB}
            >
              Registrar una tasación
            </FichaLink>
          }
          anchors={anchors}
          appreciationRate={appreciationRate}
          assetId={asset.id}
          currentUrl={valoracionUrl}
          formError={formError}
          privacyMode={privacyMode}
          today={today}
          valuationCadence={valuationCadence}
        />
        <AcquisitionCostSection
          acquisitionCostMinor={acquisitionCostMinor}
          assetId={asset.id}
          currency={asset.currency}
          currentUrl={valoracionUrl}
          currentValueMinor={value.amountMinor}
          formError={formError}
          privacyMode={privacyMode}
        />
      </>
    ),
    key: VALORACION_TAB,
    label: "Valoración",
  };
  const tabs = ownTabs.map((key) => (key === COBROS_TAB ? cobros.tab : valoracion));

  return holdingSurface("housing", {
    ficha: {
      actions,
      errorTargets: {
        ...cobros.errorTargets,
        // The tab's own forms print on it; a refused new anchor reopens its panel.
        acquisitionCost: { tab: VALORACION_TAB },
        cadence: { tab: VALORACION_TAB },
        rate: { tab: VALORACION_TAB },
        ...Object.fromEntries(
          anchors.map((anchor) => [`anchor-${anchor.id}`, { tab: VALORACION_TAB }]),
        ),
        [ANCHOR_FORM_ID]: { action: TASACION_ACTION, tab: VALORACION_TAB },
      },
      figures,
      instrument: INSTRUMENT_LABELS_ES[instrumentOfAsset(asset)],
      // «Registrar tasación» prints its own refusal, in its panel (#1847).
      ownErrorForms: [ANCHOR_FORM_ID],
      rows: { ...payoutsPanel.rows, tasaciones: anchors.map((anchor) => anchor.id) },
      tabs,
      value: money(value.amountMinor),
      // No ledger: the band's warnings are about the holding's own row.
      warnings: holdingWarnings({ asset, id, operations: [], overrides }),
    },
  });
}
