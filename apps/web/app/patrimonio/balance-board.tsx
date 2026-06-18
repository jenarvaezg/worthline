import type { TrashView } from "@worthline/db";
import type { DomainWarning, PortfolioGroup, UnifiedHolding } from "@worthline/domain";
import { formatMoneyMinor } from "@worthline/domain";
import Link from "next/link";

import { boardRefreshHover } from "../price-refresh";

import {
  acknowledgeWarningAction,
  deleteAssetAction,
  deleteLiabilityAction,
  emptyTrashAction,
  hardDeleteAssetAction,
  hardDeleteLiabilityAction,
  restoreAssetAction,
  restoreLiabilityAction,
} from "./actions";

/**
 * The /patrimonio holdings list (#271). A two-pane balance sheet: assets left,
 * liabilities right, physically separated so direction never needs a colour to be
 * read. The selected grouping axis (#154) becomes subsections inside each pane — on
 * the liquidity axis a mortgage sits opposite the home it secures. Each pane carries
 * a composition bar (by subsection, in rung colour) and every row a weight bar scaled
 * to its SECTION, so a dominant holding never flattens the smaller rungs into nothing.
 * A footer reconciles Activos − Pasivos = Patrimonio neto, and the Papelera is part
 * of that footer rather than a stray panel.
 *
 * Zero client JS (ADR 0009): the ⋯ menu, delete confirmations and the trash are all
 * native <details>; every mutation is a server-action <form>.
 */

type Currency = PortfolioGroup["totalMinor"]["currency"];

/** A holding's magnitude in minor units — value for an asset, balance for a debt. */
function magnitude(h: UnifiedHolding): number {
  return h.direction === "asset" ? h.valueMinor : h.balanceMinor;
}

function money(amountMinor: number, currency: Currency): string {
  return formatMoneyMinor({ amountMinor, currency });
}

/** The css custom property carrying a rung's identity colour (design-system §5). */
function tierVar(tier: UnifiedHolding["tier"]): string {
  return `var(--tier-${tier})`;
}

/** Ownership label for household scope ("60 %" / "100 %"), or null outside household. */
function ownershipLabel(h: UnifiedHolding, isHousehold: boolean): string | null {
  if (!isHousehold) return null;
  const bps = h.ownership.totalShareBps;
  // Floor-cap the partial branch so 99.5–99.99 % never rounds up to "100 %" and
  // hides that the holding is co-owned (the whole reason the label exists).
  return bps < 10_000 ? `${Math.min(99, Math.round(bps / 100))} %` : "100 %";
}

interface Section {
  key: string;
  label: string;
  tier: UnifiedHolding["tier"];
  rows: UnifiedHolding[];
}

/**
 * One direction's holdings as labelled subsections. Sections keep the grouping-axis
 * order (ladder for Liquidez, first-seen for Instrumento); rows WITHIN a section are
 * sorted by amount, largest first. `.filter` already copies, so the sort never
 * mutates the projection.
 */
function sectionsFor(
  groups: PortfolioGroup[],
  direction: UnifiedHolding["direction"],
): Section[] {
  return groups
    .map((g) => {
      const rows = g.holdings
        .filter((h) => h.direction === direction)
        .sort((a, b) => magnitude(b) - magnitude(a));
      return { key: g.key, label: g.label, tier: rows[0]?.tier ?? "cash", rows };
    })
    .filter((s) => s.rows.length > 0);
}

const sectionTotal = (rows: UnifiedHolding[]) =>
  rows.reduce((acc, h) => acc + magnitude(h), 0);

/** Composition segments for a pane: by subsection when subdivided, else by holding. */
function paneSegments(sections: Section[], isAsset: boolean) {
  const denom = sections.reduce((acc, s) => acc + sectionTotal(s.rows), 0) || 1;
  const color = (tier: UnifiedHolding["tier"]) =>
    isAsset ? tierVar(tier) : "var(--red)";
  const segments =
    sections.length > 1
      ? sections.map((s) => ({
          key: s.key,
          value: sectionTotal(s.rows),
          color: color(s.tier),
          label: s.label,
        }))
      : (sections[0]?.rows ?? []).map((h) => ({
          key: h.id,
          value: magnitude(h),
          color: color(h.tier),
          label: h.name,
        }));
  return { denom, segments };
}

function HoldingRow({
  holding,
  currency,
  isAsset,
  isHousehold,
  warnings,
  currentUrl,
  sectionDenom,
  showTierLabel,
  nowIso,
}: {
  holding: UnifiedHolding;
  currency: Currency;
  isAsset: boolean;
  isHousehold: boolean;
  warnings: DomainWarning[];
  currentUrl: string;
  sectionDenom: number;
  showTierLabel: boolean;
  nowIso: string;
}) {
  const h = holding;
  const rowWarnings = isAsset
    ? warnings.filter((w) => w.entityType === "asset" && w.entityId === h.id)
    : [];
  const ack = rowWarnings.find((w) => w.severity === "overrideable");
  const derived = h.direction === "asset" && h.valueIsDerived;
  // Enrich the derived-value badge's native hover with WHEN/WHO last priced it
  // (#303). Only an investment valued from the price cache carries this; null for
  // a manual-priced one, so the title stays just "Valor calculado (…)".
  const refreshHover =
    h.direction === "asset"
      ? boardRefreshHover(h.priceFetchedAt, h.priceSource, nowIso)
      : null;
  const own = ownershipLabel(h, isHousehold);
  const pct = (magnitude(h) / sectionDenom) * 100;
  const deleteAction = isAsset ? deleteAssetAction : deleteLiabilityAction;

  return (
    <div className="balanceRow" id={h.id}>
      <div className="balanceRowName">
        <Link href={h.detailHref}>{h.name}</Link>
        {rowWarnings.length > 0 ? (
          <span
            className="warningBadge"
            role="img"
            aria-label={rowWarnings[0]!.message}
            title={rowWarnings[0]!.message}
          >
            {" "}
            ⚠
          </span>
        ) : null}
        <div className="balanceRowSub">
          {showTierLabel && h.tierLabel ? <span>{h.tierLabel}</span> : null}
          {own ? <span>· {own}</span> : null}
        </div>
      </div>

      <div className="balanceRowAmount">
        {derived ? (
          <abbr
            className="balanceCalc"
            aria-label="Valor calculado"
            title={`Valor calculado (unidades × precio)${refreshHover ?? ""}`}
          >
            ≈
          </abbr>
        ) : null}
        {isAsset ? money(magnitude(h), currency) : `− ${money(magnitude(h), currency)}`}
      </div>

      <details className="balanceActions">
        <summary aria-label={`Acciones para ${h.name}`}>⋯</summary>
        <div className="balanceMenu">
          <Link href={h.detailHref}>Editar</Link>
          {ack ? (
            <form action={acknowledgeWarningAction}>
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <input name="code" type="hidden" value={ack.code} />
              <input name="entityId" type="hidden" value={h.id} />
              <button className="balanceMenuAck" type="submit">
                Es intencional
              </button>
            </form>
          ) : null}
          <form action={deleteAction}>
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={h.id} />
            <details className="confirmDelete balanceMenuDelete">
              <summary>Eliminar</summary>
              <button type="submit">Confirmar</button>
            </details>
          </form>
        </div>
      </details>

      <div className="balanceRowBar">
        <span
          style={{
            width: `${pct}%`,
            background: isAsset ? tierVar(h.tier) : "var(--red)",
          }}
        />
      </div>
    </div>
  );
}

function Pane({
  title,
  total,
  currency,
  sections,
  isAsset,
  isHousehold,
  warnings,
  currentUrl,
  nowIso,
}: {
  title: string;
  total: number;
  currency: Currency;
  sections: Section[];
  isAsset: boolean;
  isHousehold: boolean;
  warnings: DomainWarning[];
  currentUrl: string;
  nowIso: string;
}) {
  const { denom, segments } = paneSegments(sections, isAsset);
  const showSubs = sections.length > 1;

  return (
    <div className={`balancePane ${isAsset ? "balancePaneAsset" : "balancePaneDebt"}`}>
      <div className="balancePaneHead">
        <div className="balancePaneTop">
          <h3>{title}</h3>
          <span className="balancePaneTotal">
            {isAsset ? money(total, currency) : `− ${money(total, currency)}`}
          </span>
        </div>
        {segments.length > 0 ? (
          <div
            className="balanceCompBar"
            role="img"
            aria-label={`Composición de ${title}`}
          >
            {segments.map((s) => (
              <span
                className="balanceCompSeg"
                key={s.key}
                title={`${s.label} · ${money(s.value, currency)}`}
                style={{ width: `${(s.value / denom) * 100}%`, background: s.color }}
              />
            ))}
          </div>
        ) : null}
      </div>

      {sections.length === 0 ? (
        <p className="balancePaneEmpty">{isAsset ? "Sin activos." : "Sin deudas."}</p>
      ) : (
        sections.map((s) => {
          const secDenom = sectionTotal(s.rows) || 1;
          return (
            <div key={s.key}>
              {showSubs ? (
                <div className="balanceSub">
                  <span className="balanceSubLabel">
                    <span
                      className="balanceDot"
                      style={{ background: isAsset ? tierVar(s.tier) : "var(--red)" }}
                    />
                    {s.label}
                  </span>
                  <span className="balanceSubTotal">{money(secDenom, currency)}</span>
                </div>
              ) : null}
              {s.rows.map((h) => (
                <HoldingRow
                  currency={currency}
                  currentUrl={currentUrl}
                  holding={h}
                  isAsset={isAsset}
                  isHousehold={isHousehold}
                  key={h.id}
                  nowIso={nowIso}
                  sectionDenom={secDenom}
                  showTierLabel={!showSubs}
                  warnings={warnings}
                />
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}

function TrashRow({
  id,
  name,
  restoreAction,
  hardDeleteAction,
  currentUrl,
}: {
  id: string;
  name: string;
  restoreAction: typeof restoreAssetAction;
  hardDeleteAction: typeof hardDeleteAssetAction;
  currentUrl: string;
}) {
  return (
    <div className="balanceTrashRow">
      <span>{name}</span>
      <span className="balanceTrashRowActions">
        <form action={restoreAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={id} />
          <button className="btnSmall" type="submit">
            Restaurar
          </button>
        </form>
        <form action={hardDeleteAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={id} />
          <details className="confirmDelete">
            <summary>Eliminar definitivamente</summary>
            <button type="submit">Confirmar borrado definitivo</button>
          </details>
        </form>
      </span>
    </div>
  );
}

export interface BalanceBoardProps {
  groups: PortfolioGroup[];
  isHousehold: boolean;
  warnings: DomainWarning[];
  trash: TrashView;
  currentUrl: string;
  /** Server render instant — anchors the derived-value badge's relative date (#303). */
  nowIso: string;
}

export default function BalanceBoard({
  groups,
  isHousehold,
  warnings,
  trash,
  currentUrl,
  nowIso,
}: BalanceBoardProps) {
  const currency: Currency = groups[0]?.totalMinor.currency ?? "EUR";
  const assetSections = sectionsFor(groups, "asset");
  const debtSections = sectionsFor(groups, "liability");
  const grossAssets = assetSections.reduce((acc, s) => acc + sectionTotal(s.rows), 0);
  const totalDebts = debtSections.reduce((acc, s) => acc + sectionTotal(s.rows), 0);
  const net = grossAssets - totalDebts;
  const trashCount = trash.assets.length + trash.liabilities.length;

  if (groups.length === 0) {
    return (
      <section aria-label="Holdings" className="balanceBoard">
        <p className="balanceEmpty">
          Sin holdings todavía. <Link href="/patrimonio/anadir">Añadir holding →</Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Activos y pasivos" className="balanceBoard">
      <Pane
        currency={currency}
        currentUrl={currentUrl}
        isAsset
        isHousehold={isHousehold}
        nowIso={nowIso}
        sections={assetSections}
        title="Activos"
        total={grossAssets}
        warnings={warnings}
      />
      <Pane
        currency={currency}
        currentUrl={currentUrl}
        isAsset={false}
        isHousehold={isHousehold}
        nowIso={nowIso}
        sections={debtSections}
        title="Pasivos"
        total={totalDebts}
        warnings={warnings}
      />

      <div className="balanceRecon">
        <span className="balanceReconTitle">Balance</span>
        <div className="balanceReconFigures">
          <span className="balanceReconItem">
            <span className="balanceReconLabel">Activos</span>
            <span className="balanceReconValue">{money(grossAssets, currency)}</span>
          </span>
          <span className="balanceReconItem">
            <span className="balanceReconOp">−</span>
            <span className="balanceReconLabel">Pasivos</span>
            <span className="balanceReconValue">{money(totalDebts, currency)}</span>
          </span>
          <span className="balanceReconItem balanceReconNet">
            <span className="balanceReconOp">=</span>
            <span className="balanceReconLabel">Patrimonio neto</span>
            <span className={`balanceReconValue${net < 0 ? " balanceReconNeg" : ""}`}>
              {money(net, currency)}
            </span>
          </span>
        </div>
      </div>

      <details className="balanceTrash">
        <summary>Papelera ({trashCount})</summary>
        {trashCount === 0 ? (
          <p className="balanceTrashEmpty">La papelera está vacía.</p>
        ) : (
          <div className="balanceTrashList">
            {trash.assets.map((item) => (
              <TrashRow
                currentUrl={currentUrl}
                hardDeleteAction={hardDeleteAssetAction}
                id={item.id}
                key={item.id}
                name={item.name}
                restoreAction={restoreAssetAction}
              />
            ))}
            {trash.liabilities.map((item) => (
              <TrashRow
                currentUrl={currentUrl}
                hardDeleteAction={hardDeleteLiabilityAction}
                id={item.id}
                key={item.id}
                name={item.name}
                restoreAction={restoreLiabilityAction}
              />
            ))}
          </div>
        )}
        {trashCount > 0 ? (
          <form action={emptyTrashAction} className="balanceTrashEmptyAll">
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <details className="confirmDelete">
              <summary>Vaciar papelera</summary>
              <button type="submit">Confirmar vaciado de papelera</button>
            </details>
          </form>
        ) : null}
      </details>
    </section>
  );
}
