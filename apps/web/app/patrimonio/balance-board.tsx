"use client";

import type { TrashView } from "@worthline/db";
import type { DomainWarning, PortfolioGroup, UnifiedHolding } from "@worthline/domain";
import { formatMoneyMinorPrivacy } from "@worthline/domain";
import Link from "next/link";
import { useOptimistic, useTransition, type FormEvent } from "react";

import { boardRefreshHover } from "@web/price-refresh";
import { PendingSubmit } from "@web/pending-submit";

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
import {
  applyBoardMutations,
  type BoardModel,
  type BoardMutation,
} from "./optimistic-board";

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
 * Optimistic mutations (#521, S5 of #485, interaction-patterns §4/§7/§8). This is the
 * ADR 0036 client island for the board: deleting a row (and emptying / hard-deleting
 * from the trash) shows immediately via `useOptimistic` folding the in-flight mutation
 * over the server model with the pure `applyBoardMutations`; the redirect every action
 * ends with re-renders server truth and settles it, or — on the error redirect —
 * reverts the optimistic change while the error band surfaces (§4). The forms keep a
 * plain server-action `action=` so they still work with JS off (progressive
 * enhancement); when JS is on, `onSubmit` intercepts to apply the optimistic merge in
 * a transition. The saving state is announced through a board-level `aria-live` region
 * (§8) — it lives OUTSIDE the optimistically-removed row, so the announcement is not
 * torn down with the row. In demo (`readOnly`) the optimism is skipped (§10): the
 * write-guard rejects the action, so a faked-then-reverted change would only flicker.
 */

type Currency = PortfolioGroup["totalMinor"]["currency"];

/** A holding's magnitude in minor units — value for an asset, balance for a debt. */
function magnitude(h: UnifiedHolding): number {
  return h.direction === "asset" ? h.valueMinor : h.balanceMinor;
}

function money(amountMinor: number, currency: Currency, privacyMode: boolean): string {
  return formatMoneyMinorPrivacy({ amountMinor, currency }, privacyMode);
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

/**
 * Build an `onSubmit` that applies the optimistic merge before invoking the server
 * action, all inside a transition so `useOptimistic` tracks it and React keeps the
 * saving state pending until the action's redirect lands. `null` in demo, where the
 * form falls back to the plain server-action post (no faked optimism, §10).
 */
type OptimisticSubmit = (
  mutation: BoardMutation,
  action: (formData: FormData) => unknown,
) => ((event: FormEvent<HTMLFormElement>) => void) | undefined;

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
  privacyMode,
  optimisticSubmit,
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
  privacyMode: boolean;
  optimisticSubmit: OptimisticSubmit;
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
        {isAsset
          ? money(magnitude(h), currency, privacyMode)
          : `− ${money(magnitude(h), currency, privacyMode)}`}
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
          <form
            action={deleteAction}
            onSubmit={optimisticSubmit({ kind: "delete", id: h.id }, deleteAction)}
          >
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
  privacyMode,
  optimisticSubmit,
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
  privacyMode: boolean;
  optimisticSubmit: OptimisticSubmit;
}) {
  const { denom, segments } = paneSegments(sections, isAsset);
  const showSubs = sections.length > 1;

  return (
    <div className={`balancePane ${isAsset ? "balancePaneAsset" : "balancePaneDebt"}`}>
      <div className="balancePaneHead">
        <div className="balancePaneTop">
          <h3>{title}</h3>
          <span className="balancePaneTotal">
            {isAsset
              ? money(total, currency, privacyMode)
              : `− ${money(total, currency, privacyMode)}`}
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
                title={`${s.label} · ${money(s.value, currency, privacyMode)}`}
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
                  <span className="balanceSubTotal">
                    {money(secDenom, currency, privacyMode)}
                  </span>
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
                  optimisticSubmit={optimisticSubmit}
                  privacyMode={privacyMode}
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
  optimisticSubmit,
}: {
  id: string;
  name: string;
  restoreAction: typeof restoreAssetAction;
  hardDeleteAction: typeof hardDeleteAssetAction;
  currentUrl: string;
  optimisticSubmit: OptimisticSubmit;
}) {
  return (
    <div className="balanceTrashRow">
      <span>{name}</span>
      <span className="balanceTrashRowActions">
        {/* Restore is NOT optimistic (§4): the board row it re-adds cannot be
            reconstructed from the trash's {id,name}, so faking it would show a wrong
            value. It stays a plain server-action post that re-renders on its redirect. */}
        <form action={restoreAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={id} />
          <PendingSubmit className="btnSmall" pendingLabel="Restaurando…">
            Restaurar
          </PendingSubmit>
        </form>
        <form
          action={hardDeleteAction}
          onSubmit={optimisticSubmit({ kind: "hardDelete", id }, hardDeleteAction)}
        >
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
  privacyMode: boolean;
  /** Demo: skip optimistic state — the write-guard rejects, so optimism would flicker (§10). */
  readOnly?: boolean;
}

export default function BalanceBoard({
  groups,
  isHousehold,
  warnings,
  trash,
  currentUrl,
  nowIso,
  privacyMode,
  readOnly = false,
}: BalanceBoardProps) {
  const base: BoardModel = { groups, trash };
  const [model, addPending] = useOptimistic(
    base,
    (current: BoardModel, mutation: BoardMutation) =>
      applyBoardMutations(current, [mutation]),
  );
  const [isPending, startTransition] = useTransition();

  // Apply the optimistic merge, then run the action — both inside the transition so
  // `useOptimistic` tracks the change and `isPending` stays true until the action's
  // redirect lands. In demo we return undefined: the form falls back to its plain
  // `action=` post, which the write-guard rejects — no faked optimism (§10).
  const optimisticSubmit: OptimisticSubmit = (mutation, action) => {
    if (readOnly) {
      return undefined;
    }
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      startTransition(async () => {
        addPending(mutation);
        await action(formData);
      });
    };
  };

  const currency: Currency = model.groups[0]?.totalMinor.currency ?? "EUR";
  const assetSections = sectionsFor(model.groups, "asset");
  const debtSections = sectionsFor(model.groups, "liability");
  const grossAssets = assetSections.reduce((acc, s) => acc + sectionTotal(s.rows), 0);
  const totalDebts = debtSections.reduce((acc, s) => acc + sectionTotal(s.rows), 0);
  const net = grossAssets - totalDebts;
  const trashCount = model.trash.assets.length + model.trash.liabilities.length;

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
      {/* Announce the in-flight save for screen readers (§8). It sits at the board
          root — outside any optimistically-removed row — so the announcement is not
          torn down with the row it describes. The settled outcome is announced by the
          page's existing success/error band (role="status"/"alert") after the redirect. */}
      <p aria-live="polite" className="srOnly">
        {isPending ? "Guardando…" : ""}
      </p>

      <Pane
        currency={currency}
        currentUrl={currentUrl}
        isAsset
        isHousehold={isHousehold}
        nowIso={nowIso}
        optimisticSubmit={optimisticSubmit}
        privacyMode={privacyMode}
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
        optimisticSubmit={optimisticSubmit}
        privacyMode={privacyMode}
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
            <span className="balanceReconValue">
              {money(grossAssets, currency, privacyMode)}
            </span>
          </span>
          <span className="balanceReconItem">
            <span className="balanceReconOp">−</span>
            <span className="balanceReconLabel">Pasivos</span>
            <span className="balanceReconValue">
              {money(totalDebts, currency, privacyMode)}
            </span>
          </span>
          <span className="balanceReconItem balanceReconNet">
            <span className="balanceReconOp">=</span>
            <span className="balanceReconLabel">Patrimonio neto</span>
            <span className={`balanceReconValue${net < 0 ? " balanceReconNeg" : ""}`}>
              {money(net, currency, privacyMode)}
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
            {model.trash.assets.map((item) => (
              <TrashRow
                currentUrl={currentUrl}
                hardDeleteAction={hardDeleteAssetAction}
                id={item.id}
                key={item.id}
                name={item.name}
                optimisticSubmit={optimisticSubmit}
                restoreAction={restoreAssetAction}
              />
            ))}
            {model.trash.liabilities.map((item) => (
              <TrashRow
                currentUrl={currentUrl}
                hardDeleteAction={hardDeleteLiabilityAction}
                id={item.id}
                key={item.id}
                name={item.name}
                optimisticSubmit={optimisticSubmit}
                restoreAction={restoreLiabilityAction}
              />
            ))}
          </div>
        )}
        {trashCount > 0 ? (
          <form
            action={emptyTrashAction}
            className="balanceTrashEmptyAll"
            onSubmit={optimisticSubmit({ kind: "emptyTrash" }, emptyTrashAction)}
          >
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
