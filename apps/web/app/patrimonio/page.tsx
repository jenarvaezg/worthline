import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  collectWarnings,
  formatMoneyMinor,
  groupPortfolio,
  listScopeOptions,
  moneySign,
  projectPortfolio,
} from "@worthline/domain";
import type { PortfolioGroupKey } from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  appendParam,
  buildCurrentUrlFor,
  parseFormError,
  parseGroupParam,
  parseScopeParam,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
} from "../intake";
import Shell from "../shell";
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
import PatrimonioGroupControls from "./group-controls";

export const dynamic = "force-dynamic";

export default async function PatrimonioPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);
  const currentUrl = buildCurrentUrlFor("/patrimonio", resolvedSearchParams);
  const selectedGroup = parseGroupParam(resolvedSearchParams?.group);

  const jar = await cookies();
  const queryScopeId = parseScopeParam(resolvedSearchParams?.scope);
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = withStore((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScopeId = queryScopeId ?? cookieScopeId;
    const selectedScope =
      scopes.find((scope) => scope.id === selectedScopeId) ?? scopes[0];

    return {
      assets: store.assets.readAssets(),
      liabilities: store.liabilities.readLiabilities(),
      overrides: store.readWarningOverrides(),
      scopes,
      selectedScope,
      trash: store.readTrash(),
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const { assets, liabilities, overrides, scopes, selectedScope, trash, workspace } =
    storeData;

  const warnings = collectWarnings(assets, overrides);

  const projection = selectedScope
    ? projectPortfolio({ workspace, scope: selectedScope, assets, liabilities })
    : null;

  // The one unified list, grouped by the selected axis (#154, S8). The selected
  // group doubles as the filter — the page renders each group as its own card.
  const groups = projection ? groupPortfolio(projection, selectedGroup) : [];

  const isHousehold = workspace.mode === "household";

  /** A /patrimonio URL that selects a grouping axis, preserving scope + feedback. */
  const groupHrefFor = (group: PortfolioGroupKey): string =>
    appendParam(currentUrl, "group", group);

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl={currentUrl}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={warnings.map((w) => ({
        code: w.code,
        entityId: w.entityId,
        message: w.message,
      }))}
    >
      {formError && !formError.formId ? (
        <p className="errorBand" role="alert">
          {formError.message}
        </p>
      ) : null}

      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="patrimonioHeader" aria-label="Activos y deudas">
        <div className="panelHeader">
          <h2>Patrimonio</h2>
          <span>Activos y deudas</span>
        </div>
        <div className="patrimonioActions">
          <span>Añadir:</span>
          <Link className="actionLink" href="/patrimonio/nuevo-activo">
            + Activo
          </Link>
          <Link className="actionLink" href="/patrimonio/nueva-deuda">
            + Deuda
          </Link>
          <span className="actionDivider">·</span>
          <Link className="actionLinkMuted" href="/inversiones/nueva">
            ¿Cotiza con ticker? → Inversión
          </Link>
        </div>
        {assets.length > 0 || liabilities.length > 0 ? (
          <Link className="actionLink" href="/patrimonio/actualizar">
            Puesta al día →
          </Link>
        ) : null}
        <PatrimonioGroupControls hrefFor={groupHrefFor} selected={selectedGroup} />
      </section>

      {/* ── Unified holdings list, grouped by the selected axis (#154, S8) ──── */}
      {groups.length === 0 ? (
        <section className="patrimonioSection" aria-label="Holdings">
          <div className="tableScroll">
            <table className="patrimonioTable">
              <tbody>
                <tr>
                  <td className="emptyRow">
                    Sin holdings todavía.{" "}
                    <Link href="/patrimonio/nuevo-activo">Añadir activo →</Link>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {groups.map((group) => (
        <section className="patrimonioSection" aria-label={group.label} key={group.key}>
          <div className="patrimonioSectionHeader">
            <h3>{group.label}</h3>
            {/* A group total is a static figure → ink; only a NEGATIVE net (a rung
                or instrument that owes more than it holds) reads red, per the
                design system's "negative net in red" rule. */}
            <strong className={moneySign(group.totalMinor) === "neg" ? "neg" : undefined}>
              {formatMoneyMinor(group.totalMinor)}
            </strong>
          </div>

          <div className="tableScroll">
            <table className="patrimonioTable">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Capa</th>
                  <th>Valor</th>
                  {isHousehold ? <th>Propiedad</th> : null}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {group.holdings.map((holding) => {
                  // The signed contribution of this holding: an asset adds its
                  // value, a liability SUBTRACTS its balance. Negating the debt
                  // here (vs showing a bare positive balance) makes a debt row
                  // unambiguous in a mixed rung/instrument group — a 180.000 €
                  // debt reads "−180.000 €" in red, never identical to an asset
                  // of the same magnitude. Matches the signed group total.
                  const amountMinor =
                    holding.direction === "asset"
                      ? holding.valueMinor
                      : -holding.balanceMinor;
                  const rowWarnings =
                    holding.direction === "asset"
                      ? warnings.filter((w) => w.entityId === holding.id)
                      : [];
                  const overrideableWarning = rowWarnings.find(
                    (w) => w.severity === "overrideable",
                  );
                  // An investment's value is derived (ADR 0006) — render it read-only,
                  // but the ROW is fully actionable like any other holding (#154).
                  const valueIsDerived =
                    holding.direction === "asset" && holding.valueIsDerived;
                  const deleteAction =
                    holding.direction === "asset"
                      ? deleteAssetAction
                      : deleteLiabilityAction;

                  return (
                    <tr id={holding.id} key={holding.id}>
                      <td>
                        <Link href={holding.detailHref}>{holding.name}</Link>
                        {rowWarnings.length > 0 ? (
                          <span className="warningBadge" title={rowWarnings[0]!.message}>
                            {" "}
                            ⚠
                          </span>
                        ) : null}
                      </td>
                      <td>{holding.tierLabel}</td>
                      <td
                        className={
                          [
                            valueIsDerived ? "readOnlyValue" : "",
                            amountMinor < 0 ? "neg" : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        }
                      >
                        {formatMoneyMinor({ amountMinor, currency: "EUR" })}
                        {valueIsDerived ? <small> Valor calculado</small> : null}
                      </td>
                      {isHousehold ? (
                        <td className="ownershipCell">
                          {holding.ownership.totalShareBps < 10_000
                            ? `${Math.round(holding.ownership.totalShareBps / 100)}%`
                            : "100%"}
                        </td>
                      ) : null}
                      <td className="rowActions">
                        {overrideableWarning ? (
                          <form action={acknowledgeWarningAction}>
                            <input name="currentUrl" type="hidden" value={currentUrl} />
                            <input
                              name="code"
                              type="hidden"
                              value={overrideableWarning.code}
                            />
                            <input name="entityId" type="hidden" value={holding.id} />
                            <button className="btnSmall btnWarning" type="submit">
                              Es intencional
                            </button>
                          </form>
                        ) : null}
                        <Link className="btnSmall" href={holding.detailHref}>
                          Editar
                        </Link>
                        <form action={deleteAction}>
                          <input name="currentUrl" type="hidden" value={currentUrl} />
                          <input name="id" type="hidden" value={holding.id} />
                          <details className="confirmDelete">
                            <summary>Eliminar</summary>
                            <button type="submit">Confirmar</button>
                          </details>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {/* ── Papelera ────────────────────────────────────────────────── */}
      <section className="papelera" aria-label="Papelera">
        <details className="trashPanel">
          <summary>Papelera ({trash.assets.length + trash.liabilities.length})</summary>
          <div className="trashList">
            {trash.assets.length === 0 && trash.liabilities.length === 0 ? (
              <span className="emptyLine">La papelera está vacía.</span>
            ) : null}
            {trash.assets.map((item) => (
              <div className="trashRow" key={item.id}>
                <span>{item.name}</span>
                <div className="trashRowActions">
                  <form action={restoreAssetAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="id" type="hidden" value={item.id} />
                    <button type="submit">Restaurar</button>
                  </form>
                  <form action={hardDeleteAssetAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="id" type="hidden" value={item.id} />
                    <details className="confirmDelete">
                      <summary>Eliminar definitivamente</summary>
                      <button type="submit">Confirmar borrado definitivo</button>
                    </details>
                  </form>
                </div>
              </div>
            ))}
            {trash.liabilities.map((item) => (
              <div className="trashRow" key={item.id}>
                <span>{item.name}</span>
                <div className="trashRowActions">
                  <form action={restoreLiabilityAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="id" type="hidden" value={item.id} />
                    <button type="submit">Restaurar</button>
                  </form>
                  <form action={hardDeleteLiabilityAction}>
                    <input name="currentUrl" type="hidden" value={currentUrl} />
                    <input name="id" type="hidden" value={item.id} />
                    <details className="confirmDelete">
                      <summary>Eliminar definitivamente</summary>
                      <button type="submit">Confirmar borrado definitivo</button>
                    </details>
                  </form>
                </div>
              </div>
            ))}
          </div>
          {trash.assets.length + trash.liabilities.length > 0 ? (
            <form action={emptyTrashAction} className="trashEmptyAll">
              <input name="currentUrl" type="hidden" value={currentUrl} />
              <details className="confirmDelete">
                <summary>Vaciar papelera</summary>
                <button type="submit">Confirmar vaciado de papelera</button>
              </details>
            </form>
          ) : null}
        </details>
      </section>
    </Shell>
  );
}
