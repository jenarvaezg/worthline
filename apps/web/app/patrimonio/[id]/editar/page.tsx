import { runBootstrapHealthcheck, withStore } from "@worthline/db";
import type {
  AmortizationPlanRecord,
  BalanceAnchorRecord,
  InterestRateRevisionRecord,
  ValuationAnchorRecord,
} from "@worthline/db";
import {
  collectWarnings,
  formatMoneyInput,
  formatMoneyMinor,
  listScopeOptions,
} from "@worthline/domain";
import type { DebtModel, Liability, ManualAsset, Member } from "@worthline/domain";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  parseFormError,
  parseScopeCookie,
  resolveOkMessage,
  SCOPE_COOKIE_NAME,
  type FormErrorContext,
} from "../../../intake";
import Shell from "../../../shell";
import {
  acknowledgeWarningAction,
  addBalanceAnchorAction,
  addInterestRateRevisionAction,
  addValuationAnchorAction,
  deleteAmortizationPlanAction,
  deleteAssetAction,
  deleteBalanceAnchorAction,
  deleteInterestRateRevisionAction,
  deleteLiabilityAction,
  deleteValuationAnchorAction,
  editAssetAction,
  saveAmortizationPlanAction,
  setAppreciationRateAction,
  setDebtModelAction,
  updateAssetValuationAction,
  updateBalanceAnchorAction,
  updateInterestRateRevisionAction,
  updateLiabilityBalanceAction,
  updateValuationAnchorAction,
} from "../../actions";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

export default async function EditarPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const persistence = runBootstrapHealthcheck();
  const formError = parseFormError(resolvedSearchParams);
  const formOk = resolveOkMessage(resolvedSearchParams);

  const jar = await cookies();
  const cookieScopeId = parseScopeCookie(jar.get(SCOPE_COOKIE_NAME)?.value);

  const storeData = withStore((store) => {
    const workspace = store.workspace.readWorkspace();

    if (!workspace) {
      return null;
    }

    const scopes = listScopeOptions(workspace);
    const selectedScope = scopes.find((scope) => scope.id === cookieScopeId) ?? scopes[0];

    const assets = store.assets.readAssets();
    const liabilities = store.liabilities.readLiabilities();
    const overrides = store.readWarningOverrides();

    const asset = assets.find((a) => a.id === id) ?? null;
    const liability = liabilities.find((l) => l.id === id) ?? null;

    // Housing valuation data (PRD #108): only meaningful for a real-estate asset.
    const isHousing = asset?.type === "real_estate";
    const anchors = isHousing ? store.assets.readValuationAnchors(id) : [];
    const appreciationRate = isHousing
      ? store.assets.readAnnualAppreciationRate(id)
      : null;

    // Debt-model data (PRD #109, slice 10): only meaningful for a liability.
    const debtModel = liability ? store.liabilities.readDebtModel(id) : null;
    const amortizationPlan =
      liability && debtModel === "amortizable"
        ? store.liabilities.readAmortizationPlan(id)
        : null;
    const rateRevisions = amortizationPlan
      ? store.liabilities.readInterestRateRevisions(amortizationPlan.id)
      : [];
    const balanceAnchors =
      liability && (debtModel === "revolving" || debtModel === "informal")
        ? store.liabilities.readBalanceAnchors(id)
        : [];

    return {
      activeMembers: workspace.members.filter((m) => !m.disabledAt),
      amortizationPlan,
      anchors,
      appreciationRate,
      asset,
      assets: assets.filter((a) => a.type !== "investment"),
      balanceAnchors,
      debtModel,
      liability,
      overrides,
      rateRevisions,
      scopes,
      selectedScope,
      workspace,
    };
  });

  if (!storeData) {
    redirect("/empezar");
  }

  const {
    activeMembers,
    amortizationPlan,
    anchors,
    appreciationRate,
    asset,
    assets,
    balanceAnchors,
    debtModel,
    liability,
    overrides,
    rateRevisions,
    scopes,
    selectedScope,
  } = storeData;

  if (!asset && !liability) {
    notFound();
  }

  const today = new Date().toISOString().slice(0, 10);

  const warnings = asset ? collectWarnings([asset], overrides) : [];
  const ownershipScopeMemberId =
    activeMembers.find((m) => m.id === selectedScope?.id)?.id ?? activeMembers[0]?.id;

  return (
    <Shell
      activeSection="patrimonio"
      currentPageUrl={`/patrimonio/${id}/editar`}
      persistence={persistence}
      scopes={scopes}
      selectedScopeId={selectedScope?.id}
      warnings={[]}
    >
      {formOk ? (
        <p className="successBand" role="status">
          {formOk}
        </p>
      ) : null}

      <section className="formPage" aria-label="Editar holding">
        <div className="panelHeader">
          <h2>Editar {asset ? "activo" : "deuda"}</h2>
          <Link href={`/patrimonio#${id}`}>← Volver</Link>
        </div>

        {/* Active warnings for this holding */}
        {warnings.length > 0 ? (
          <div className="warningBand" role="alert" aria-label="Avisos">
            {warnings.map((w) => (
              <div className="warningItem" key={`${w.entityId}-${w.code}`}>
                <span>⚠ {w.message}</span>
                {w.severity === "overrideable" ? (
                  <form action={acknowledgeWarningAction}>
                    <input
                      name="currentUrl"
                      type="hidden"
                      value={`/patrimonio/${id}/editar`}
                    />
                    <input name="code" type="hidden" value={w.code} />
                    <input name="entityId" type="hidden" value={id} />
                    <button className="btnSmall btnWarning" type="submit">
                      Es intencional
                    </button>
                  </form>
                ) : (
                  <span className="blockingNote">No se puede ignorar</span>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {formError ? (
          <p className="errorBand" role="alert">
            {formError.message}
          </p>
        ) : null}

        {asset ? (
          <AssetEditForm
            asset={asset}
            members={activeMembers}
            scopeMemberId={ownershipScopeMemberId}
            values={formError?.formId === "edit" ? formError.values : {}}
          />
        ) : liability ? (
          <LiabilityEditForm
            assets={assets}
            liability={liability}
            members={activeMembers}
            scopeMemberId={ownershipScopeMemberId}
            values={formError?.formId === "edit" ? formError.values : {}}
          />
        ) : null}

        {asset?.type === "real_estate" ? (
          <HousingValuationSection
            anchors={anchors}
            appreciationRate={appreciationRate}
            assetId={asset.id}
            formError={formError}
            today={today}
          />
        ) : null}

        {liability ? (
          <DebtModelSection
            amortizationPlan={amortizationPlan}
            balanceAnchors={balanceAnchors}
            debtModel={debtModel}
            formError={formError}
            liabilityId={liability.id}
            rateRevisions={rateRevisions}
            today={today}
          />
        ) : null}

        {/* Danger zone — two-step delete */}
        <div className="dangerZone">
          <h3>Zona de peligro</h3>
          {asset ? (
            <form action={deleteAssetAction}>
              <input name="currentUrl" type="hidden" value={`/patrimonio/${id}/editar`} />
              <input name="id" type="hidden" value={id} />
              <details className="confirmDelete">
                <summary>Eliminar activo</summary>
                <p>El activo se moverá a la Papelera y podrás recuperarlo.</p>
                <button type="submit">Confirmar eliminación</button>
              </details>
            </form>
          ) : (
            <form action={deleteLiabilityAction}>
              <input name="currentUrl" type="hidden" value={`/patrimonio/${id}/editar`} />
              <input name="id" type="hidden" value={id} />
              <details className="confirmDelete">
                <summary>Eliminar deuda</summary>
                <p>La deuda se moverá a la Papelera y podrás recuperarla.</p>
                <button type="submit">Confirmar eliminación</button>
              </details>
            </form>
          )}
        </div>
      </section>
    </Shell>
  );
}

function AssetEditForm({
  asset,
  members,
  scopeMemberId,
  values,
}: {
  asset: ManualAsset;
  members: Member[];
  scopeMemberId: string | undefined;
  values: Record<string, string>;
}) {
  const isInvestment = asset.type === "investment";

  return (
    <>
      <form action={editAssetAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={`/patrimonio/${asset.id}/editar`} />
        <input name="id" type="hidden" value={asset.id} />
        <input name="scopeMemberId" type="hidden" value={scopeMemberId ?? ""} />

        <label>
          Nombre
          <input
            aria-label="Nombre del activo"
            defaultValue={values["name"] ?? asset.name}
            name="name"
            disabled={isInvestment}
          />
        </label>

        {isInvestment ? (
          <p className="infoNote">
            Este activo es una inversión gestionada en{" "}
            <Link href={`/inversiones/${asset.id}`}>Inversiones</Link>. Su nombre y capa
            se editan allí.
          </p>
        ) : (
          <>
            <label>
              Tipo
              <select defaultValue={values["type"] ?? asset.type} name="type">
                <option value="cash">Cash</option>
                <option value="manual">Manual</option>
                <option value="real_estate">Inmueble</option>
              </select>
            </label>

            <label>
              Capa de liquidez
              <select
                defaultValue={values["liquidityTier"] ?? asset.liquidityTier}
                name="liquidityTier"
              >
                <option value="cash">Caja</option>
                <option value="market">Mercado</option>
                <option value="term-locked">A plazo</option>
                <option value="illiquid">Ilíquido</option>
              </select>
            </label>

            <label className="checkLine">
              <input
                defaultChecked={
                  values["isPrimaryResidence"]
                    ? values["isPrimaryResidence"] === "on"
                    : asset.isPrimaryResidence
                }
                name="isPrimaryResidence"
                type="checkbox"
              />{" "}
              Vivienda habitual
            </label>

            <OwnershipInputs
              allowPartial={asset.type === "real_estate"}
              members={members}
              scopeMemberId={scopeMemberId}
              currentOwnership={asset.ownership}
              values={values}
            />
          </>
        )}

        {!isInvestment ? (
          <div className="formActions">
            <button type="submit">Guardar cambios</button>
            <Link href={`/patrimonio#${asset.id}`}>Cancelar</Link>
          </div>
        ) : null}
      </form>

      {!isInvestment ? (
        <form action={updateAssetValuationAction} className="stackForm updateValueForm">
          <input
            name="currentUrl"
            type="hidden"
            value={`/patrimonio/${asset.id}/editar`}
          />
          <input name="id" type="hidden" value={asset.id} />
          <label>
            Valor actual (EUR)
            <input
              aria-label="Valor actual en EUR"
              defaultValue={formatMoneyInput(asset.currentValue.amountMinor)}
              inputMode="decimal"
              name="currentValue"
            />
          </label>
          <button type="submit">Actualizar valor</button>
        </form>
      ) : (
        <p className="infoNote">
          Valor actual: {formatMoneyMinor(asset.currentValue)} — derivado de las
          posiciones.
        </p>
      )}
    </>
  );
}

function LiabilityEditForm({
  assets,
  liability,
  members,
  scopeMemberId,
  values,
}: {
  assets: ManualAsset[];
  liability: Liability;
  members: Member[];
  scopeMemberId: string | undefined;
  values: Record<string, string>;
}) {
  return (
    <>
      <form action={editAssetAction} className="stackForm">
        <input
          name="currentUrl"
          type="hidden"
          value={`/patrimonio/${liability.id}/editar`}
        />
        <input name="id" type="hidden" value={liability.id} />
        <input name="scopeMemberId" type="hidden" value={scopeMemberId ?? ""} />
        <input name="isLiability" type="hidden" value="true" />

        <label>
          Nombre
          <input
            aria-label="Nombre de la deuda"
            defaultValue={values["name"] ?? liability.name}
            name="name"
          />
        </label>

        <label>
          Tipo
          <select defaultValue={values["type"] ?? liability.type} name="type">
            <option value="mortgage">Hipoteca</option>
            <option value="debt">Deuda</option>
          </select>
        </label>

        <label>
          Activo asociado (opcional)
          <select
            defaultValue={
              values["associatedAssetId"] ?? liability.associatedAssetId ?? ""
            }
            name="associatedAssetId"
          >
            <option value="">Sin activo asociado</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <OwnershipInputs
          allowPartial={false}
          members={members}
          scopeMemberId={scopeMemberId}
          currentOwnership={liability.ownership}
          values={values}
        />

        <div className="formActions">
          <button type="submit">Guardar cambios</button>
          <Link href={`/patrimonio#${liability.id}`}>Cancelar</Link>
        </div>
      </form>

      <form action={updateLiabilityBalanceAction} className="stackForm updateValueForm">
        <input
          name="currentUrl"
          type="hidden"
          value={`/patrimonio/${liability.id}/editar`}
        />
        <input name="id" type="hidden" value={liability.id} />
        <label>
          Saldo pendiente (EUR)
          <input
            aria-label="Saldo pendiente en EUR"
            defaultValue={formatMoneyInput(liability.currentBalance.amountMinor)}
            inputMode="decimal"
            name="balance"
          />
        </label>
        <button type="submit">Actualizar saldo</button>
      </form>
    </>
  );
}

function OwnershipInputs({
  allowPartial,
  members,
  scopeMemberId,
  currentOwnership,
  values = {},
}: {
  allowPartial: boolean;
  members: Member[];
  scopeMemberId: string | undefined;
  currentOwnership: Array<{ memberId: string; shareBps: number }>;
  values?: Record<string, string>;
}) {
  if (members.length === 0 || (members.length === 1 && !allowPartial)) {
    return null;
  }

  const scopeMember = members.find((m) => m.id === scopeMemberId) ?? members[0]!;
  const preset = values["ownershipPreset"] ?? "custom";

  const currentBpsFor = (memberId: string): string => {
    const share = currentOwnership.find((s) => s.memberId === memberId);
    return share ? String(Math.round(share.shareBps / 100)) : "0";
  };

  return (
    <fieldset className="ownershipGrid">
      <legend>Propiedad</legend>
      <input name="scopeMemberId" type="hidden" value={scopeMember.id} />
      <label className="ownerPreset">
        <input
          defaultChecked={preset === "scope"}
          name="ownershipPreset"
          type="radio"
          value="scope"
        />
        100% {scopeMember.name}
      </label>
      {members.length > 1 ? (
        <label className="ownerPreset">
          <input
            defaultChecked={preset === "even"}
            name="ownershipPreset"
            type="radio"
            value="even"
          />
          Repartir a partes iguales
        </label>
      ) : null}
      <details className="ownerCustomDetails" open={preset === "custom"}>
        <summary>
          <label className="ownerPreset" style={{ display: "inline" }}>
            <input
              defaultChecked={preset === "custom"}
              name="ownershipPreset"
              type="radio"
              value="custom"
            />
            Personalizado
          </label>
        </summary>
        <div className="ownerCustom">
          {members.map((member) => (
            <label key={member.id}>
              {member.name}
              <input
                defaultValue={values[`owner_${member.id}`] ?? currentBpsFor(member.id)}
                inputMode="decimal"
                name={`owner_${member.id}`}
                aria-label={`Porcentaje de ${member.name}`}
              />
            </label>
          ))}
        </div>
      </details>
    </fieldset>
  );
}

/** Render a stored decimal rate ("0.03") back as the percent the user typed ("3"). */
function rateToPercentInput(rate: string | null): string {
  if (rate === null) {
    return "";
  }

  const pct = Number(rate) * 100;

  // Trim float noise (0.07 * 100 = 7.000000000000001) without dropping real decimals.
  return String(Math.round(pct * 1_000_000) / 1_000_000);
}

/**
 * Housing valuation editor (PRD #108, slice 6). Only rendered for real-estate
 * assets. Three stacked forms, all server-action driven (no client JS, ADR 0009):
 * the appreciation rate, a new anchor, and a date-desc list of anchors with
 * inline edit (<details>) and two-step delete per row.
 */
function HousingValuationSection({
  anchors,
  appreciationRate,
  assetId,
  formError,
  today,
}: {
  anchors: ValuationAnchorRecord[];
  appreciationRate: string | null;
  assetId: string;
  formError: FormErrorContext | null;
  today: string;
}) {
  const currentUrl = `/patrimonio/${assetId}/editar`;
  const rateValues = formError?.formId === "rate" ? formError.values : {};
  const anchorValues = formError?.formId === "anchor" ? formError.values : {};
  const sorted = [...anchors].sort((a, b) =>
    b.valuationDate.localeCompare(a.valuationDate),
  );

  return (
    <section className="housingValuation" aria-label="Valoración del inmueble">
      <h3>Valoración del inmueble</h3>

      <form action={setAppreciationRateAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={assetId} />
        <label>
          Tasa de revalorización anual (%)
          <input
            aria-label="Tasa de revalorización anual (%)"
            defaultValue={rateValues["rate"] ?? rateToPercentInput(appreciationRate)}
            inputMode="decimal"
            name="rate"
            placeholder="3"
          />
        </label>
        <p className="infoNote">
          Déjalo en blanco para no aplicar revalorización entre tasaciones.
        </p>
        <button type="submit">Guardar tasa</button>
      </form>

      <form
        action={addValuationAnchorAction}
        aria-label="Registrar tasación"
        className="stackForm"
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={assetId} />
        <AnchorFields max={today} values={anchorValues} />
        <button type="submit">Registrar tasación</button>
      </form>

      {sorted.length > 0 ? (
        <div className="tableScroll">
          <table aria-label="Tasaciones">
            <thead>
              <tr>
                <th>Fecha</th>
                <th className="numCol">Valor</th>
                <th>Tipo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((anchor) => (
                <AnchorRow
                  anchor={anchor}
                  assetId={assetId}
                  currentUrl={currentUrl}
                  formError={formError}
                  key={anchor.id}
                  max={today}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="emptyLine">Sin tasaciones registradas.</p>
      )}
    </section>
  );
}

/** Shared date / value / type fields for the add and edit anchor forms. */
function AnchorFields({ max, values }: { max: string; values: Record<string, string> }) {
  return (
    <>
      <label>
        Fecha de la tasación
        <input
          aria-label="Fecha de la tasación"
          defaultValue={values["valuationDate"]}
          max={max}
          name="valuationDate"
          required
          type="date"
        />
      </label>
      <label>
        Valor de la tasación (EUR)
        <input
          aria-label="Valor de la tasación en EUR"
          defaultValue={values["anchorValue"]}
          inputMode="decimal"
          min="0"
          name="anchorValue"
          placeholder="180.000"
          required
        />
      </label>
      <label className="checkLine">
        <input
          defaultChecked={values["adjustsPriorCurve"] === "on"}
          name="adjustsPriorCurve"
          type="checkbox"
        />{" "}
        Es una tasación de mercado
      </label>
      <p className="infoNote">
        <strong>Tasación de mercado:</strong> una valoración real del inmueble que
        recalibra toda la curva de valoraciones previas. <strong>Mejora:</strong> una
        inversión (reforma, ampliación) que se suma al valor existente sin reemplazar las
        tasaciones anteriores.
      </p>
    </>
  );
}

/** One anchor row: data + inline edit (<details>) + two-step delete (<details>). */
function AnchorRow({
  anchor,
  assetId,
  currentUrl,
  formError,
  max,
}: {
  anchor: ValuationAnchorRecord;
  assetId: string;
  currentUrl: string;
  formError: FormErrorContext | null;
  max: string;
}) {
  const editFormId = `anchor-${anchor.id}`;
  const editing = formError?.formId === editFormId;
  const editValues = editing
    ? formError.values
    : {
        adjustsPriorCurve: anchor.adjustsPriorCurve ? "on" : "",
        anchorValue: formatMoneyInput(anchor.valueMinor),
        valuationDate: anchor.valuationDate,
      };

  return (
    <tr>
      <td>{anchor.valuationDate}</td>
      <td className="numCol">
        {formatMoneyMinor({ amountMinor: anchor.valueMinor, currency: "EUR" })}
      </td>
      <td>{anchor.adjustsPriorCurve ? "Tasación" : "Mejora"}</td>
      <td className="rowActions">
        <details className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateValuationAnchorAction}
            aria-label="Editar tasación"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={assetId} />
            <input name="anchorId" type="hidden" value={anchor.id} />
            <AnchorFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar tasación</button>
            </div>
          </form>
        </details>
        <form action={deleteValuationAnchorAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={assetId} />
          <input name="anchorId" type="hidden" value={anchor.id} />
          <details className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </tr>
  );
}

/** Render a stored decimal rate ("0.025") back as the percent the user typed ("2.5"). */
function rateToPercent(rate: string): string {
  const pct = Number(rate) * 100;

  return String(Math.round(pct * 1_000_000) / 1_000_000);
}

const DEBT_MODEL_LABELS: Record<DebtModel, string> = {
  amortizable: "Amortizable (préstamo francés)",
  informal: "Informal",
  revolving: "Revolving",
};

/**
 * Debt-model editor (PRD #109, slice 10). Only rendered for liabilities. All
 * forms are server-action driven (no client JS, ADR 0009): the model selector
 * posts and the page re-renders the matching sub-section from the stored
 * `debt_model`. Conditional rendering is therefore server-side — there is no
 * useState. Inline edit uses <details>, delete is two-step.
 */
function DebtModelSection({
  amortizationPlan,
  balanceAnchors,
  debtModel,
  formError,
  liabilityId,
  rateRevisions,
  today,
}: {
  amortizationPlan: AmortizationPlanRecord | null;
  balanceAnchors: BalanceAnchorRecord[];
  debtModel: DebtModel | null;
  formError: FormErrorContext | null;
  liabilityId: string;
  rateRevisions: InterestRateRevisionRecord[];
  today: string;
}) {
  const currentUrl = `/patrimonio/${liabilityId}/editar`;

  return (
    <section className="debtModel" aria-label="Modelo de deuda">
      <h3>Modelo de deuda</h3>

      <form action={setDebtModelAction} className="stackForm">
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={liabilityId} />
        <label>
          Modelo de deuda
          <select
            aria-label="Modelo de deuda"
            defaultValue={debtModel ?? ""}
            name="debtModel"
          >
            <option value="">Sin modelo</option>
            <option value="amortizable">{DEBT_MODEL_LABELS.amortizable}</option>
            <option value="revolving">{DEBT_MODEL_LABELS.revolving}</option>
            <option value="informal">{DEBT_MODEL_LABELS.informal}</option>
          </select>
        </label>
        <p className="infoNote">
          Elige cómo evoluciona el saldo de la deuda en el histórico. Al cambiarlo se
          muestra el formulario correspondiente.
        </p>
        <button type="submit">Guardar modelo</button>
      </form>

      {debtModel === "amortizable" ? (
        <AmortizablePlanEditor
          currentUrl={currentUrl}
          formError={formError}
          liabilityId={liabilityId}
          plan={amortizationPlan}
          rateRevisions={rateRevisions}
          today={today}
        />
      ) : null}

      {debtModel === "revolving" || debtModel === "informal" ? (
        <BalanceAnchorEditor
          balanceAnchors={balanceAnchors}
          currentUrl={currentUrl}
          formError={formError}
          liabilityId={liabilityId}
          today={today}
        />
      ) : null}
    </section>
  );
}

/** Shared plan fields for the create/edit amortization-plan form. */
function PlanFields({ max, values }: { max: string; values: Record<string, string> }) {
  return (
    <>
      <label>
        Capital inicial (EUR)
        <input
          aria-label="Capital inicial en EUR"
          defaultValue={values["initialCapital"]}
          inputMode="decimal"
          min="0"
          name="initialCapital"
          placeholder="200.000"
          required
        />
      </label>
      <label>
        Tipo de interés anual (%)
        <input
          aria-label="Tipo de interés anual (%)"
          defaultValue={values["annualInterestRate"]}
          inputMode="decimal"
          min="0"
          name="annualInterestRate"
          placeholder="2,5"
          required
        />
      </label>
      <label>
        Plazo (meses)
        <input
          aria-label="Plazo en meses"
          defaultValue={values["termMonths"]}
          inputMode="numeric"
          min="1"
          name="termMonths"
          placeholder="360"
          required
          step="1"
        />
      </label>
      <label>
        Fecha de inicio
        <input
          aria-label="Fecha de inicio"
          defaultValue={values["startDate"]}
          max={max}
          name="startDate"
          required
          type="date"
        />
      </label>
    </>
  );
}

/** The amortizable sub-section: the plan (create or edit) plus its rate revisions. */
function AmortizablePlanEditor({
  currentUrl,
  formError,
  liabilityId,
  plan,
  rateRevisions,
  today,
}: {
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  plan: AmortizationPlanRecord | null;
  rateRevisions: InterestRateRevisionRecord[];
  today: string;
}) {
  const planValues =
    formError?.formId === "plan"
      ? formError.values
      : plan
        ? {
            annualInterestRate: rateToPercent(plan.annualInterestRate),
            initialCapital: formatMoneyInput(plan.initialCapitalMinor),
            startDate: plan.startDate,
            termMonths: String(plan.termMonths),
          }
        : {};
  const revisionValues = formError?.formId === "revision" ? formError.values : {};
  const sortedRevisions = [...rateRevisions].sort((a, b) =>
    b.revisionDate.localeCompare(a.revisionDate),
  );

  return (
    <div className="debtModelDetail">
      <form
        action={saveAmortizationPlanAction}
        aria-label="Plan de amortización"
        className="stackForm"
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={liabilityId} />
        <PlanFields max={today} values={planValues} />
        <div className="formActions">
          <button type="submit">{plan ? "Actualizar plan" : "Guardar plan"}</button>
        </div>
      </form>

      {plan ? (
        <form action={deleteAmortizationPlanAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="planId" type="hidden" value={plan.id} />
          <details className="confirmDelete">
            <summary>Eliminar plan</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      ) : null}

      {plan ? (
        <>
          <h4>Revisiones de tipo</h4>
          <form
            action={addInterestRateRevisionAction}
            aria-label="Registrar revisión de tipo"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="planId" type="hidden" value={plan.id} />
            <RevisionFields max={today} values={revisionValues} />
            <button type="submit">Registrar revisión</button>
          </form>

          {sortedRevisions.length > 0 ? (
            <div className="tableScroll">
              <table aria-label="Revisiones de tipo">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th className="numCol">Nuevo tipo</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRevisions.map((revision) => (
                    <RevisionRow
                      currentUrl={currentUrl}
                      formError={formError}
                      key={revision.id}
                      liabilityId={liabilityId}
                      max={today}
                      planId={plan.id}
                      revision={revision}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="emptyLine">Sin revisiones de tipo registradas.</p>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Shared date / rate fields for the add and edit revision forms. */
function RevisionFields({
  max,
  values,
}: {
  max: string;
  values: Record<string, string>;
}) {
  return (
    <>
      <label>
        Fecha de la revisión
        <input
          aria-label="Fecha de la revisión"
          defaultValue={values["revisionDate"]}
          max={max}
          name="revisionDate"
          required
          type="date"
        />
      </label>
      <label>
        Nuevo tipo de interés (%)
        <input
          aria-label="Nuevo tipo de interés (%)"
          defaultValue={values["newAnnualInterestRate"]}
          inputMode="decimal"
          min="0"
          name="newAnnualInterestRate"
          placeholder="3"
          required
        />
      </label>
    </>
  );
}

/** One revision row: data + inline edit (<details>) + two-step delete. */
function RevisionRow({
  currentUrl,
  formError,
  liabilityId,
  max,
  planId,
  revision,
}: {
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  max: string;
  planId: string;
  revision: InterestRateRevisionRecord;
}) {
  const editFormId = `revision-${revision.id}`;
  const editing = formError?.formId === editFormId;
  const editValues = editing
    ? formError.values
    : {
        newAnnualInterestRate: rateToPercent(revision.newAnnualInterestRate),
        revisionDate: revision.revisionDate,
      };

  return (
    <tr>
      <td>{revision.revisionDate}</td>
      <td className="numCol">{rateToPercent(revision.newAnnualInterestRate)} %</td>
      <td className="rowActions">
        <details className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateInterestRateRevisionAction}
            aria-label="Editar revisión de tipo"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="planId" type="hidden" value={planId} />
            <input name="revisionId" type="hidden" value={revision.id} />
            <RevisionFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar revisión</button>
            </div>
          </form>
        </details>
        <form action={deleteInterestRateRevisionAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="planId" type="hidden" value={planId} />
          <input name="revisionId" type="hidden" value={revision.id} />
          <details className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </tr>
  );
}

/** Shared date / balance fields for the add and edit balance-anchor forms. */
function BalanceAnchorFields({
  max,
  values,
}: {
  max: string;
  values: Record<string, string>;
}) {
  return (
    <>
      <label>
        Fecha del saldo
        <input
          aria-label="Fecha del saldo"
          defaultValue={values["anchorDate"]}
          max={max}
          name="anchorDate"
          required
          type="date"
        />
      </label>
      <label>
        Saldo restante (EUR)
        <input
          aria-label="Saldo restante en EUR"
          defaultValue={values["balance"]}
          inputMode="decimal"
          min="0"
          name="balance"
          placeholder="12.500"
          required
        />
      </label>
    </>
  );
}

/** The revolving/informal sub-section: declare a balance anchor + list them. */
function BalanceAnchorEditor({
  balanceAnchors,
  currentUrl,
  formError,
  liabilityId,
  today,
}: {
  balanceAnchors: BalanceAnchorRecord[];
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  today: string;
}) {
  const anchorValues = formError?.formId === "balanceAnchor" ? formError.values : {};
  const sorted = [...balanceAnchors].sort((a, b) =>
    b.anchorDate.localeCompare(a.anchorDate),
  );

  return (
    <div className="debtModelDetail">
      <h4>Saldos declarados</h4>
      <form
        action={addBalanceAnchorAction}
        aria-label="Registrar saldo"
        className="stackForm"
      >
        <input name="currentUrl" type="hidden" value={currentUrl} />
        <input name="id" type="hidden" value={liabilityId} />
        <BalanceAnchorFields max={today} values={anchorValues} />
        <p className="infoNote">
          Declara el total adeudado en esa fecha (intereses incluidos).
        </p>
        <button type="submit">Registrar saldo</button>
      </form>

      {sorted.length > 0 ? (
        <div className="tableScroll">
          <table aria-label="Saldos declarados">
            <thead>
              <tr>
                <th>Fecha</th>
                <th className="numCol">Saldo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((anchor) => (
                <BalanceAnchorRow
                  anchor={anchor}
                  currentUrl={currentUrl}
                  formError={formError}
                  key={anchor.id}
                  liabilityId={liabilityId}
                  max={today}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="emptyLine">Sin saldos declarados.</p>
      )}
    </div>
  );
}

/** One balance-anchor row: data + inline edit (<details>) + two-step delete. */
function BalanceAnchorRow({
  anchor,
  currentUrl,
  formError,
  liabilityId,
  max,
}: {
  anchor: BalanceAnchorRecord;
  currentUrl: string;
  formError: FormErrorContext | null;
  liabilityId: string;
  max: string;
}) {
  const editFormId = `balanceAnchor-${anchor.id}`;
  const editing = formError?.formId === editFormId;
  const editValues = editing
    ? formError.values
    : {
        anchorDate: anchor.anchorDate,
        balance: formatMoneyInput(anchor.balanceMinor),
      };

  return (
    <tr>
      <td>{anchor.anchorDate}</td>
      <td className="numCol">
        {formatMoneyMinor({ amountMinor: anchor.balanceMinor, currency: "EUR" })}
      </td>
      <td className="rowActions">
        <details className="anchorEdit" open={editing}>
          <summary>Editar</summary>
          <form
            action={updateBalanceAnchorAction}
            aria-label="Editar saldo"
            className="stackForm"
          >
            <input name="currentUrl" type="hidden" value={currentUrl} />
            <input name="id" type="hidden" value={liabilityId} />
            <input name="anchorId" type="hidden" value={anchor.id} />
            <BalanceAnchorFields max={max} values={editValues} />
            <div className="formActions">
              <button type="submit">Guardar saldo</button>
            </div>
          </form>
        </details>
        <form action={deleteBalanceAnchorAction}>
          <input name="currentUrl" type="hidden" value={currentUrl} />
          <input name="id" type="hidden" value={liabilityId} />
          <input name="anchorId" type="hidden" value={anchor.id} />
          <details className="confirmDelete">
            <summary>Eliminar</summary>
            <button type="submit">Confirmar</button>
          </details>
        </form>
      </td>
    </tr>
  );
}
