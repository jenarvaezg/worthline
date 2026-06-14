import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import {
  collectWarnings,
  formatMoneyMinor,
  listScopeOptions,
  moneySign,
  projectPortfolio,
} from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  buildCurrentUrlFor,
  parseFormError,
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

  const [assetsSection, liabilitiesSection] = projection
    ? projection.sections
    : [
        { kind: "assets" as const, rows: [] },
        { kind: "liabilities" as const, rows: [] },
      ];

  const liabilityTypeById = new Map(liabilities.map((l) => [l.id, l.type]));

  const isHousehold = workspace.mode === "household";

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
          <Link className="actionLinkMuted" href="/inversiones">
            ¿Cotiza con ticker? → Inversiones
          </Link>
        </div>
        {assets.filter((a) => a.type !== "investment").length > 0 ||
        liabilities.length > 0 ? (
          <Link className="actionLink" href="/patrimonio/actualizar">
            Puesta al día →
          </Link>
        ) : null}
      </section>

      {/* ── Activos ─────────────────────────────────────────────────── */}
      <section className="patrimonioSection" aria-label="Activos">
        <div className="patrimonioSectionHeader">
          <h3>Activos</h3>
          {projection ? (
            <strong className={moneySign(projection.totalGrossAssets)}>
              {formatMoneyMinor(projection.totalGrossAssets)}
            </strong>
          ) : null}
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
              {assetsSection.rows.length === 0 ? (
                <tr>
                  <td colSpan={isHousehold ? 5 : 4} className="emptyRow">
                    Sin activos todavía.{" "}
                    <Link href="/patrimonio/nuevo-activo">Añadir activo →</Link>
                  </td>
                </tr>
              ) : null}
              {assetsSection.rows.map((row) => {
                const rowWarnings = warnings.filter((w) => w.entityId === row.id);
                const overrideableWarning = rowWarnings.find(
                  (w) => w.severity === "overrideable",
                );

                return (
                  <tr id={row.id} key={row.id}>
                    <td>
                      {row.isReadOnly ? (
                        <Link href={row.detailHref!}>{row.name}</Link>
                      ) : (
                        row.name
                      )}
                      {rowWarnings.length > 0 ? (
                        <span className="warningBadge" title={rowWarnings[0]!.message}>
                          {" "}
                          ⚠
                        </span>
                      ) : null}
                    </td>
                    <td>{row.tierLabel}</td>
                    <td className={row.isReadOnly ? "readOnlyValue" : undefined}>
                      {formatMoneyMinor({ amountMinor: row.valueMinor, currency: "EUR" })}
                      {row.isReadOnly ? (
                        <small>
                          {" "}
                          <Link href={row.detailHref!}>ver ficha →</Link>
                        </small>
                      ) : null}
                    </td>
                    {isHousehold ? (
                      <td className="ownershipCell">
                        {row.ownership.totalShareBps < 10_000
                          ? `${Math.round(row.ownership.totalShareBps / 100)}%`
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
                          <input name="entityId" type="hidden" value={row.id} />
                          <button className="btnSmall btnWarning" type="submit">
                            Es intencional
                          </button>
                        </form>
                      ) : null}
                      {!row.isReadOnly ? (
                        <Link className="btnSmall" href={`/patrimonio/${row.id}/editar`}>
                          Editar
                        </Link>
                      ) : null}
                      {!row.isReadOnly ? (
                        <form action={deleteAssetAction}>
                          <input name="currentUrl" type="hidden" value={currentUrl} />
                          <input name="id" type="hidden" value={row.id} />
                          <details className="confirmDelete">
                            <summary>Eliminar</summary>
                            <button type="submit">Confirmar</button>
                          </details>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Deudas ──────────────────────────────────────────────────── */}
      <section className="patrimonioSection" aria-label="Deudas">
        <div className="patrimonioSectionHeader">
          <h3>Deudas</h3>
          {projection ? (
            <strong className={moneySign(projection.totalDebts)}>
              {formatMoneyMinor(projection.totalDebts)}
            </strong>
          ) : null}
        </div>

        <div className="tableScroll">
          <table className="patrimonioTable">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Saldo</th>
                {isHousehold ? <th>Propiedad</th> : null}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {liabilitiesSection.rows.length === 0 ? (
                <tr>
                  <td colSpan={isHousehold ? 4 : 3} className="emptyRow">
                    Sin deudas registradas.{" "}
                    <Link href="/patrimonio/nueva-deuda">Añadir deuda →</Link>
                  </td>
                </tr>
              ) : null}
              {liabilitiesSection.rows.map((row) => (
                <tr id={row.id} key={row.id}>
                  <td>{row.name}</td>
                  <td>
                    {liabilityTypeById.get(row.id) === "mortgage" ? "Hipoteca" : "Deuda"}
                  </td>
                  <td>
                    {formatMoneyMinor({
                      amountMinor: row.balanceMinor,
                      currency: "EUR",
                    })}
                  </td>
                  {isHousehold ? (
                    <td className="ownershipCell">
                      {row.ownership.totalShareBps < 10_000
                        ? `${Math.round(row.ownership.totalShareBps / 100)}%`
                        : "100%"}
                    </td>
                  ) : null}
                  <td className="rowActions">
                    <Link className="btnSmall" href={`/patrimonio/${row.id}/editar`}>
                      Editar
                    </Link>
                    <form action={deleteLiabilityAction}>
                      <input name="currentUrl" type="hidden" value={currentUrl} />
                      <input name="id" type="hidden" value={row.id} />
                      <details className="confirmDelete">
                        <summary>Eliminar</summary>
                        <button type="submit">Confirmar</button>
                      </details>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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
