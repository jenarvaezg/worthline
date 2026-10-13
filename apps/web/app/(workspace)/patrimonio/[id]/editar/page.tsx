/**
 * The holding ficha (#152, ADR 0014) — and, since #1607, ONLY the orchestration
 * of it.
 *
 * The page does four things and no more: resolve which holding the public
 * `wl_hld_…` id names (#1318), load the surface family that holding belongs to
 * (`_families/holding-surface`), render the chrome every ficha shares — the
 * feedback bands, «Lo básico», the Zona de peligro — and lay the family out the
 * way the family says: its body inside the «Configuración avanzada» disclosure, or
 * (#1826) the tabbed ficha, where that chrome becomes the «Datos del activo» tab.
 *
 * What it deliberately does NOT do is branch on the instrument. It used to: a
 * dozen booleans re-tested at every read and again at every section, every family's
 * rows loaded in the same preamble whether or not the holding was one of them.
 * Which surface a holding gets is now one call to `holdingFamily`, and what that
 * surface needs is the family's own business.
 */

import { isDemoMode } from "@web/demo/write-guard";
import {
  holdingBoardHref,
  holdingDetailHref,
  holdingPublicIdIndex,
  resolveHoldingRoute,
} from "@web/holding-route";
import { parseFormError, resolveOkMessage } from "@web/intake";
import { COBRO_FORM_ID } from "@web/inversiones/cobro-form-ids";
import { updateInvestmentAction } from "@web/inversiones/update-investment-action";
import { resolvePageShell } from "@web/page-shell";
import { VALUE_FORM_ID } from "@web/patrimonio/action-helpers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadAvailabilityPanel } from "./_chrome/availability-panel";
import { loadDangerPanel } from "./_chrome/danger-panel";
import { holdingWarnings } from "./_chrome/holding-warnings";
import { loadPayoutsPanel } from "./_chrome/payouts-panel";
import { WarningsBand } from "./_chrome/warnings-band";
import type { FichaContext } from "./_families/family-contract";
import { loadHoldingSurface } from "./_families/holding-surface";
import type { FichaTarget } from "./_ficha/ficha-view";
import { FICHA_DATOS_TAB, fichaTabUrl } from "./_ficha/ficha-view";
import { HoldingFicha } from "./_ficha/holding-ficha";
import { AssetEditForm, LiabilityEditForm } from "./_surfaces/holding-forms";
import { ANCHOR_FORM_ID } from "./_surfaces/housing-valuation-section";
import { TRASH_FORM_ID } from "./_surfaces/trash-exit-form";

/** The forms that render their own error band, next to the field that produced it. */
const SECTIONS_WITH_OWN_ERROR_BAND = [
  "operation",
  ...Object.values(COBRO_FORM_ID),
  "transfer",
  TRASH_FORM_ID,
  // «Traer de otra entidad» prints its own band (#1518): without it here, its
  // refusal was printed twice.
  "externalEntry",
  // «Actualizar valor» prints its own, in «Lo básico» or in the panel (#1846).
  VALUE_FORM_ID,
  // «Registrar tasación» prints its own, in the property's panel (#1847).
  ANCHOR_FORM_ID,
];

/**
 * The chrome's own forms, all of which live in «Datos del activo» on a tabbed ficha.
 * A family that moved one of them out says so in its own targets, which win: the
 * value form is in «Lo básico» unless the family's bar offers it (#1846).
 */
const CHROME_ERROR_TARGETS: Readonly<Record<string, FichaTarget>> = {
  availableFrom: { tab: FICHA_DATOS_TAB },
  edit: { tab: FICHA_DATOS_TAB },
  [TRASH_FORM_ID]: { tab: FICHA_DATOS_TAB },
  [VALUE_FORM_ID]: { tab: FICHA_DATOS_TAB },
};

/**
 * Block (#1229): this route opts out of Instant Navigations validation.
 * Soft-click shell prefetching is not the goal here — see the route table on
 * issue #1229 for the why.
 */
export const instant = false;

type Params = Promise<{ id: string }>;

export default async function EditarPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: publicId } = await params;
  const resolvedSearchParams = await searchParams;
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const { persistence, privacyMode, selectedScope, store, workspace } =
    await resolvePageShell({ searchParams: resolvedSearchParams });

  // Independent base reads — one wave instead of serial round-trips (#446).
  const [allAssets, liabilities, overrides, publicIds] = await Promise.all([
    store.assets.readAssets(),
    store.liabilities.readLiabilities(),
    store.readWarningOverrides(),
    store.agentView.readPublicIds(),
  ]);

  // The route names the holding by its public `wl_hld_…` id (#1318) — the same
  // id the agent view and the MCP take, so what the user (or the assistant
  // reading `screenContext`) has in the URL bar is directly actionable. The
  // internal storage id is resolved here and never leaves the server.
  const resolvedId = resolveHoldingRoute(publicId, holdingPublicIdIndex(publicIds));

  if (resolvedId === null) {
    notFound();
  }
  const id: string = resolvedId;

  const asset = allAssets.find((a) => a.id === id) ?? null;
  const liability = liabilities.find((l) => l.id === id) ?? null;

  const currentUrl = holdingDetailHref(publicId);
  const boardHref = holdingBoardHref(publicId);
  const today = new Date().toISOString().slice(0, 10);
  // Demo skips optimistic mutations — the write-guard rejects them (§10).
  const isDemo = await isDemoMode();

  // Everything resolved before the ficha knows which family it is looking at.
  const ficha = {
    allAssets,
    // `?archivar=1`: the Papelera's «Lo traspasé a…» exit came back here (#1549).
    archiveOriginAfterTransfer: resolvedSearchParams?.archivar === "1",
    baseCurrency: workspace.baseCurrency,
    checkedAt: persistence.checkedAt,
    currentUrl,
    formError,
    id,
    isDemo,
    overrides,
    privacyMode,
    store,
    today,
  } satisfies FichaContext;

  // Cobros rides on every asset ficha whatever its family, so it is loaded here
  // and PLACED by the family — only the family knows where in its own order the
  // panel belongs. A liability pays nobody and loads nothing, so the panel travels
  // WITH the asset: there is no asset without one to guard against downstream.
  const assetWithPanel = asset
    ? {
        payoutsPanel: await loadPayoutsPanel(ficha, {
          asset,
          overrides,
          scopeId: selectedScope?.id,
        }),
        row: asset,
      }
    : null;

  // The one dispatch: which family this holding belongs to, and everything that
  // family needs — its rows, its sections, its bound actions (#1607). Null when
  // the resolved id names neither an asset nor a liability.
  const surface = await loadHoldingSurface({
    ...ficha,
    asset: assetWithPanel,
    liability,
  });

  if (surface === null) {
    notFound();
  }

  const activeMembers = workspace.members.filter((m) => !m.disabledAt);
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  // On a tabbed ficha the chrome's forms live in «Datos del activo», so that is
  // where their terminals return (#1826); elsewhere, to the ficha as it was.
  const layout = surface.layout;
  const fichaTabKeys =
    layout.kind === "ficha"
      ? [...layout.ficha.tabs.map((tab) => tab.key), FICHA_DATOS_TAB]
      : null;
  const chromeUrl = fichaTabKeys
    ? fichaTabUrl(currentUrl, fichaTabKeys, FICHA_DATOS_TAB)
    : currentUrl;
  const chromeContext = { ...ficha, currentUrl: chromeUrl };

  // The Papelera's «Lo traspasé a…» exit returns HERE with the advanced block
  // unfolded and the archive intent in the URL (#1549) — the traspaso surface is
  // inside a collapsed <details>, so a bare fragment would reveal nothing. (A
  // tabbed ficha reads the same `?abrir=` in its island, `_ficha/ficha-view.ts`.)
  const abrir = resolvedSearchParams?.abrir;
  const advancedOpen =
    abrir === "operaciones" || abrir === "traspaso" || abrir === "cobros";

  // «Lo básico» is the one form the page itself owns, so its action is bound here.
  async function boundUpdateInvestmentAction(formData: FormData) {
    "use server";
    await updateInvestmentAction(id, formData);
  }

  // La disponibilidad va con el ESCALÓN, no con la familia (#1528): el panel decide
  // solo, y devuelve null para cualquier holding que no esté a plazo. La página no
  // pregunta por el peldaño — un booleano más aquí es lo que #1607 vino a quitar.
  const availabilityPanel = await loadAvailabilityPanel(chromeContext, asset);

  const dangerPanel = await loadDangerPanel(chromeContext, {
    asset,
    manualLedger: surface.manualLedger,
    trashImpact: surface.trashImpact,
  });

  // A tabbed ficha prints some warnings beside their figure and links the rest to
  // the tab where each is fixed (#1828); the accordion keeps its band as it was.
  const bandPlacement =
    layout.kind === "ficha" && fichaTabKeys
      ? {
          exclude: layout.ficha.inlineWarnings ?? [],
          fixes: Object.fromEntries(
            Object.entries(layout.ficha.warningFixes ?? {}).map(([code, fix]) => [
              code,
              { ...fix, href: fichaTabUrl(currentUrl, fichaTabKeys, fix.tab) },
            ]),
          ),
        }
      : {};

  // The holding's active warnings, read once (#1731 review): a tabbed family already
  // read them to place its inline ones; the accordion's are read here.
  const warnings =
    layout.kind === "ficha"
      ? layout.ficha.warnings
      : holdingWarnings({ asset, id, operations: surface.operations, overrides });

  const warningsBand = (
    <WarningsBand
      currentUrl={currentUrl}
      id={id}
      warnings={warnings}
      {...bandPlacement}
    />
  );

  const basicsSection = (
    <section className="editBasic" aria-labelledby="edit-basic-title">
      <h3 id="edit-basic-title">Lo básico</h3>
      {asset ? (
        <AssetEditForm
          asset={asset}
          boardHref={boardHref}
          currentUrl={chromeUrl}
          investment={surface.basics.investment}
          isBinanceHolding={surface.basics.isBinanceHolding}
          isCoinCollection={surface.basics.isCoinCollection}
          members={activeMembers}
          method={surface.basics.method}
          formError={formError}
          privacyMode={privacyMode}
          scopeMemberId={ownershipScopeMemberId}
          showValueForm={surface.basics.showValueForm}
          updateInvestmentAction={boundUpdateInvestmentAction}
          valueOnlyOpening={surface.basics.valueOnlyOpening}
          values={formError?.formId === "edit" ? formError.values : {}}
        />
      ) : liability ? (
        <LiabilityEditForm
          assets={allAssets.filter((a) => a.type !== "investment")}
          boardHref={boardHref}
          currentUrl={chromeUrl}
          liability={liability}
          members={activeMembers}
          scopeMemberId={ownershipScopeMemberId}
          showRawBalanceForm={surface.basics.showRawBalanceForm}
          values={formError?.formId === "edit" ? formError.values : {}}
        />
      ) : null}
    </section>
  );

  const okBand = formOk ? (
    <p className="successBand" role="status">
      {formOk}
    </p>
  ) : null;

  // The page-level band carries only the errors NO section prints itself. The list
  // is the seam: a section that grows its own band adds itself here, and the reader
  // sees at a glance which forms speak for themselves.
  const errorBand =
    formError && !SECTIONS_WITH_OWN_ERROR_BAND.includes(formError.formId ?? "") ? (
      <p className="errorBand" role="alert">
        {formError.message}
      </p>
    ) : null;

  if (layout.kind === "ficha") {
    const { ficha: tabbed } = layout;
    const holdingFicha = (
      <HoldingFicha
        actions={tabbed.actions}
        basePath={currentUrl}
        boardHref={boardHref}
        errorTargets={{ ...CHROME_ERROR_TARGETS, ...tabbed.errorTargets }}
        figures={tabbed.figures}
        instrument={tabbed.instrument}
        name={(asset ?? liability)?.name ?? ""}
        // The success notice sits inside the ficha, beside the tabs where the result
        // landed, and offers «Añadir otra» after a panel's submit (#1829).
        notice={formOk}
        rows={tabbed.rows ?? {}}
        tabs={[
          ...tabbed.tabs,
          {
            content: (
              <div className="fichaDatos">
                {basicsSection}
                {availabilityPanel}
                {/* Last on purpose: the two-step delete, with the truth about what
                    it withdraws, is the one thing on this tab nobody comes for. */}
                {dangerPanel}
              </div>
            ),
            key: FICHA_DATOS_TAB,
            label: "Datos del activo",
            shortLabel: "Datos",
          },
        ]}
        value={tabbed.value}
      />
    );

    return (
      <section className="formPage fichaPage" aria-label="Ficha del activo">
        {warningsBand}
        {errorBand}
        {tabbed.wrap ? tabbed.wrap(holdingFicha) : holdingFicha}
      </section>
    );
  }

  return (
    <>
      {okBand}

      <section className="formPage" aria-label="Editar holding">
        <div className="panelHeader">
          <h2>Editar {asset ? "activo" : "deuda"}</h2>
          <Link href={boardHref}>← Volver</Link>
        </div>

        {warningsBand}

        {errorBand}

        {basicsSection}

        {/* Fuera del plegable a propósito: cuando la fecha NO está declarada, esta
            superficie es lo único que lo dice, y un aviso escondido tras un
            «Configuración avanzada» no avisa de nada. */}
        {availabilityPanel}

        <details suppressHydrationWarning className="editAdvanced" open={advancedOpen}>
          <summary>Configuración avanzada</summary>
          <div className="editAdvancedBody">{layout.body}</div>
        </details>

        {/* Danger zone — two-step delete, with the truth about what it withdraws */}
        {dangerPanel}
      </section>
    </>
  );
}
