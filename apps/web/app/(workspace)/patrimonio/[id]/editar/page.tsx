/**
 * The holding ficha (#152, ADR 0014) — and, since #1607, ONLY the orchestration
 * of it.
 *
 * The page does four things and no more: resolve which holding the public
 * `wl_hld_…` id names (#1318), load the surface family that holding belongs to
 * (`_families/holding-surface`), render the chrome every ficha shares — the
 * feedback bands, «Lo básico», the advanced disclosure, the Zona de peligro — and
 * hand the family's body to the middle of it.
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
import { updateInvestmentAction } from "@web/inversiones/update-investment-action";
import { resolvePageShell } from "@web/page-shell";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadDangerPanel } from "./_chrome/danger-panel";
import { loadPayoutsPanel } from "./_chrome/payouts-panel";
import { WarningsBand } from "./_chrome/warnings-band";
import type { FichaContext } from "./_families/family-contract";
import { loadHoldingSurface } from "./_families/holding-surface";
import { AssetEditForm, LiabilityEditForm } from "./_surfaces/holding-forms";

/** The forms that render their own error band, next to the field that produced it. */
const SECTIONS_WITH_OWN_ERROR_BAND = ["operation", "payout", "transfer", "trash"];

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
    checkedAt: persistence.checkedAt,
    currentUrl,
    formError,
    id,
    isDemo,
    privacyMode,
    store,
    today,
  } satisfies FichaContext;

  // Cobros rides on every asset ficha whatever its family, so it is loaded here
  // and PLACED by the family — only the family knows where in its own order the
  // panel belongs. A liability pays nobody and loads nothing.
  const payoutsPanel = asset
    ? await loadPayoutsPanel(ficha, { asset, scopeId: selectedScope?.id })
    : null;

  // The one dispatch: which family this holding belongs to, and everything that
  // family needs — its rows, its sections, its bound actions (#1607). Null when
  // the resolved id names neither an asset nor a liability.
  const surface = await loadHoldingSurface({ ...ficha, asset, liability, payoutsPanel });

  if (surface === null) {
    notFound();
  }

  const activeMembers = workspace.members.filter((m) => !m.disabledAt);
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  // The Papelera's «Lo traspasé a…» exit returns HERE with the advanced block
  // unfolded and the archive intent in the URL (#1549) — the traspaso surface is
  // inside a collapsed <details>, so a bare fragment would reveal nothing.
  const abrir = resolvedSearchParams?.abrir;
  const advancedOpen =
    abrir === "operaciones" || abrir === "traspaso" || abrir === "cobros";

  // «Lo básico» is the one form the page itself owns, so its action is bound here.
  async function boundUpdateInvestmentAction(formData: FormData) {
    "use server";
    await updateInvestmentAction(id, formData);
  }

  const dangerPanel = await loadDangerPanel(ficha, {
    asset,
    manualLedger: surface.manualLedger,
    trashImpact: surface.trashImpact,
  });

  return (
    <>
      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="formPage" aria-label="Editar holding">
        <div className="panelHeader">
          <h2>Editar {asset ? "activo" : "deuda"}</h2>
          <Link href={boardHref}>← Volver</Link>
        </div>

        <WarningsBand
          asset={asset}
          currentUrl={currentUrl}
          id={id}
          operations={surface.operations}
          overrides={overrides}
        />

        {/* The page-level band carries only the errors NO section prints itself. The
            list is the seam: a section that grows its own band adds itself here, and
            the reader sees at a glance which forms speak for themselves. */}
        {formError && !SECTIONS_WITH_OWN_ERROR_BAND.includes(formError.formId ?? "") ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        <section className="editBasic" aria-labelledby="edit-basic-title">
          <h3 id="edit-basic-title">Lo básico</h3>
          {asset ? (
            <AssetEditForm
              asset={asset}
              boardHref={boardHref}
              currentUrl={currentUrl}
              investment={surface.basics.investment}
              isBinanceHolding={surface.basics.isBinanceHolding}
              isCoinCollection={surface.basics.isCoinCollection}
              members={activeMembers}
              method={surface.basics.method}
              privacyMode={privacyMode}
              scopeMemberId={ownershipScopeMemberId}
              updateInvestmentAction={boundUpdateInvestmentAction}
              valueOnlyOpening={surface.basics.valueOnlyOpening}
              values={formError?.formId === "edit" ? formError.values : {}}
            />
          ) : liability ? (
            <LiabilityEditForm
              assets={allAssets.filter((a) => a.type !== "investment")}
              boardHref={boardHref}
              currentUrl={currentUrl}
              liability={liability}
              members={activeMembers}
              scopeMemberId={ownershipScopeMemberId}
              showRawBalanceForm={surface.basics.showRawBalanceForm}
              values={formError?.formId === "edit" ? formError.values : {}}
            />
          ) : null}
        </section>

        <details suppressHydrationWarning className="editAdvanced" open={advancedOpen}>
          <summary>Configuración avanzada</summary>
          <div className="editAdvancedBody">{surface.body}</div>
        </details>

        {/* Danger zone — two-step delete, with the truth about what it withdraws */}
        {dangerPanel}
      </section>
    </>
  );
}
