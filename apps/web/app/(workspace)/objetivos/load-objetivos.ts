/**
 * Objetivos load module (#1700, auditoría termonuclear #1692).
 *
 * Sibling of {@link loadPatrimonio}: one input in, one result out. The /objetivos
 * page used to assemble its own read model inline — thirteen parallel store
 * reads plus every derivation the screen needs (the FIRE state, the saved
 * assumptions draft, the monthly allocation window, the contribution
 * reconciliation projection, the annual contribution allowances with their
 * consumed usage, the passive-income lens, the exposure-drift trajectories) —
 * inside the page function, which had grown to ~840 lines. That assembly lives
 * here now, testable outside the page against the in-memory store, so the page
 * only renders.
 *
 * Cache-only GET, like its sibling: this path performs NO network and NO writes.
 * It reads the cached prices and computes today's figures live from the same
 * curve-valued ledger snapshot capture uses.
 *
 * What deliberately stays in the page: the URL. The month of the allocation
 * island, the exposure-drift year and growth assumption and the reconciliation
 * anchor are view state (interaction-patterns §2), parsed against the window
 * this module serves — `allocationWindow`, `exposureDriftTrajectories` — never
 * inside it.
 */

import {
  readDebtModelByLiabilityId,
  readMonthlyDebtServiceByLiabilityId,
} from "@web/debt-service-reads";
import { holdingPublicIdIndex } from "@web/holding-route";
import { readExposureProfilesFromCatalog } from "@web/read-exposure-catalog";
import type { WorthlineStore } from "@worthline/db";
import type {
  ContributionAllowance,
  ContributionAllowanceUsage,
  ContributionPlan,
  ContributionReconciliationProjection,
  ExposureDriftPoint,
  FireAgeSource,
  FireGrowthAssumption,
  HoldingReturnsView,
  InvestmentOperation,
  LocalPersistenceStatus,
  ManualAsset,
  MonthlyContributionAllocation,
  MonthlySavingsSuggestion,
  ObjetivosState,
  PassiveIncomeLens,
  ScopeOption,
  Workspace,
} from "@worthline/domain";
import {
  collectHoldingPayouts,
  computeContributionAllowanceUsage,
  computeMonthlyContributionAllocation,
  instrumentOfAsset,
  investmentReturnsById,
  monthlyCloseValuesByHolding,
  prepareObjetivosState,
  projectContributionReconciliation,
  resolveScopeMemberIds,
  scopeAgeSource,
  scopePassiveIncome,
  suggestMonthlySavingsCapacity,
  unitPriceMajorByHoldingId,
} from "@worthline/domain";
import { buildExposureDriftTrajectories } from "./build-exposure-drift";
import { allocationMonthKeys } from "./contribution-allocation-view";
import {
  contributionAllowanceDestinationOptions,
  contributionAllowanceOperations,
  trashAssetToHolding,
  withDerivedAllowanceDestinations,
} from "./contribution-allowance-view";
import type { FireAssumptionDraft } from "./fire-assumption-draft";
import { fireConfigFieldValues } from "./fire-config-form-view";

export interface LoadObjetivosInput {
  /** The open store to use for all reads. Caller owns lifecycle (#1025). */
  store: WorthlineStore;
  /** The resolved workspace (base currency, mode, members). */
  workspace: Workspace;
  /** Every scope option — `prepareObjetivosState` weighs ownership with them. */
  scopes: ScopeOption[];
  /** The selected scope, or undefined when there is none — then everything empties. */
  selectedScope: ScopeOption | undefined;
  /** Persistence status, threaded into the state for the savings testigo (#1449). */
  persistence: LocalPersistenceStatus;
  /** "Today" as YYYY-MM-DD — anchors curve valuation, the FIRE age and the windows. */
  today: string;
}

export interface LoadObjetivosResult extends ObjetivosState {
  /** Curve-valued assets at `today` — the rows the chip pickers and the panels name. */
  assets: ManualAsset[];
  /**
   * Where the FIRE age came from (#1415), so the assumptions fold can cite the
   * birth year instead of showing an age that looks typed in.
   */
  ageSource: FireAgeSource | null;
  /** The savings suggestion from the measured ledger (#425). */
  savingsSuggestion: MonthlySavingsSuggestion;
  /** Whether the saved capacity was seeded from the contribution plan (#1687). */
  seededFromPlan: boolean;
  /**
   * The assumptions island's initial draft: EXACTLY the saved values, as the form
   * paints them. Derived from `fireConfigFieldValues` — the same source the form
   * preloads — because a divergence would make the screen open believing it has
   * unsaved changes (or, worse, hide the ones it has).
   */
  savedDraft: FireAssumptionDraft;
  /** Public `wl_hld_…` id per internal asset id (#1318, #1510). */
  publicIdByAssetId: Readonly<Record<string, string>>;
  /** The months the allocation island serves; the URL is clamped to this window. */
  allocationWindow: string[];
  /** The month the island opens on when the URL names none. */
  allocationDefaultMonth: string;
  /** One pre-computed allocation per served month, or null with no plan (#557). */
  monthlyAllocations: MonthlyContributionAllocation[] | null;
  /** The scope's contribution plan, or null when it has none. */
  contributionPlan: ContributionPlan | null;
  /** The plan's next 90 days against the ledger, or null without a plan. */
  contributionProjection: ContributionReconciliationProjection | null;
  /** The investment ledger the reconciliation table reconciles against. */
  contributionOperations: InvestmentOperation[];
  /** Suggested unit price per holding id, from the cached quotes. */
  unitPrices: Record<string, string>;
  /** The scope's annual allowances, destinations re-derived per read (#1509). */
  derivedAllowances: ContributionAllowance[];
  /** The holdings an allowance may name as a destination. */
  allowanceDestinationOptions: ManualAsset[];
  /** Consumed-vs-declared for each allowance, keyed by allowance id (#1427). */
  allowanceUsageById: Map<string, ContributionAllowanceUsage>;
  /**
   * Holding names, papelera included: a destination whose contributions DO count
   * has to be nameable, or the panel would call it invisible (#1509).
   */
  holdingNameById: Map<string, string>;
  /** Which of those destinations are in the papelera. */
  trashedHoldingIds: Set<string>;
  /** The trailing-12m payouts lens, or null without a scope (#658). */
  passiveIncome: PassiveIncomeLens | null;
  /** Exposure drift per growth assumption, or null when there is no plan to walk. */
  exposureDriftTrajectories: Record<FireGrowthAssumption, ExposureDriftPoint[]> | null;
}

/**
 * Assemble the /objetivos read model. See the module doc for what it owns.
 */
export async function loadObjetivos(
  input: LoadObjetivosInput,
): Promise<LoadObjetivosResult> {
  const { store, workspace, scopes, selectedScope, persistence, today } = input;

  // The shared raw-reads context (operations, prices, ownership) built once and
  // reused: it feeds the curve valuation below AND every ledger-derived figure
  // on the page, so no surface re-reads the operations table (#1235).
  const projectionContext = await store.snapshots.buildProjectionContext();

  // These reads are independent of one another, so fire them in one wave instead
  // of stacking serial round-trips to the (remote) store (#446).
  const [
    { assets, liabilities },
    goals,
    fireConfig,
    payoutRecords,
    payoutSchedules,
    contributionPlan,
    contributionReconciliations,
    contributionAllowances,
    priceCache,
    investmentMeta,
    exposureProfiles,
    returnSnapshotRows,
    publicIdRows,
  ] = await Promise.all([
    store.snapshots.readCurveValuedHoldingsAtDate(today, projectionContext),
    selectedScope ? store.goals.readGoals(selectedScope.id) : Promise.resolve([]),
    // Derived FIRE age measured on this page's "today" (#1415).
    store.readFireConfig(today),
    store.payouts.readPayouts(),
    store.payouts.readPayoutSchedules(),
    selectedScope
      ? store.contributionPlan.readContributionPlan(selectedScope.id)
      : Promise.resolve(null),
    selectedScope
      ? store.contributionPlan.readReconciliations(selectedScope.id)
      : Promise.resolve([]),
    selectedScope
      ? store.contributionAllowances.readContributionAllowances(selectedScope.id)
      : Promise.resolve([]),
    store.operations.readAllPriceCacheEntries(),
    store.assets.readInvestmentAssetsWithMeta(),
    readExposureProfilesFromCatalog(),
    store.snapshots.readSnapshotHoldings({
      includePositions: false,
      kind: "asset",
      scopeId: selectedScope?.id ?? "household",
    }),
    store.agentView.readPublicIds(),
  ]);

  // La cuota vigente de cada deuda (#1520), para que las dos tarjetas de €/mes digan
  // bajo qué supuesto hablan. Va después de la tanda de arriba porque necesita las
  // deudas ya leídas, y solo toca las que declaran modelo amortizable — en una
  // cartera real, una o dos.
  const debtServiceByLiabilityId = await readMonthlyDebtServiceByLiabilityId(
    store.agentView,
    await readDebtModelByLiabilityId(store.agentView, liabilities),
    today,
  );

  const publicIdByAssetId = Object.fromEntries(
    holdingPublicIdIndex(publicIdRows).publicByInternal,
  );

  // Derived from projectionContext.operationsByAsset (already read above via
  // buildProjectionContext) instead of one readOperations query per investment
  // asset — same rows, same per-asset order (readAllOperations sorts by
  // executedAt, occurredAt, id, matching readOperations) (#1235).
  const contributionOperations = assets
    .filter((asset) => asset.type === "investment")
    .flatMap((asset) => projectionContext.operationsByAsset.get(asset.id) ?? []);

  // Recorded payouts up to today, keyed by holding — the single source S1
  // owns, so this surface never re-derives a schedule.
  const payoutsByHolding = collectHoldingPayouts(payoutRecords, payoutSchedules, today);

  const state = prepareObjetivosState({
    assets,
    // Las cuotas que el testigo del gasto declarado cruza (#1520) — leídas arriba,
    // así que la glosa de las tarjetas y el aviso de salud citan la misma cifra.
    debtServiceByLiabilityId,
    fireConfig,
    goals,
    // The ledger behind the achievement-badge veto (#1449) — already read above.
    investmentOperationsByAssetId: projectionContext.operationsByAsset,
    liabilities,
    // The declared rents the FIRE rate reads (#1448) — already loaded above for the
    // passive-income lens, so the two surfaces cannot disagree about them.
    payoutSchedules,
    persistence,
    positions: [],
    priceCache,
    scopes,
    selectedScope,
    selectedView: "liquid",
    snapshots: [],
    today,
    workspace,
  });
  const { fireProjection, fireResult, fireScopeConfig } = state;

  const currency = workspace.baseCurrency;

  // Where the FIRE age came from (#1415), so the assumptions fold can cite the birth
  // year instead of showing an age that looks typed in. Same rule the reader used:
  // `scopeCurrentAge` IS this function's `.age`.
  const ageSource = selectedScope
    ? (scopeAgeSource(workspace, selectedScope.id, today) ?? null)
    : null;

  // Los supuestos se editan aquí (#1450), así que esta página carga lo que el
  // formulario necesita y /ajustes deja de hacerlo: la sugerencia de ahorro por
  // histórico (#425) se saca de las operaciones que ya están leídas arriba.
  const savingsSuggestion = suggestMonthlySavingsCapacity(contributionOperations);
  const seededFromPlan = fireScopeConfig?.monthlySavingsCapacitySeededFromPlan === true;
  // El borrador inicial de la isla sale de los MISMOS valores que precarga el
  // formulario: si divergieran, la pantalla nacería creyendo que hay cambios sin
  // guardar (o al revés, tapando los que hay).
  const savedFieldValues = fireConfigFieldValues(fireScopeConfig);
  const savedDraft: FireAssumptionDraft = {
    // La declaración del inmovilizado sale de los MISMOS valores del formulario
    // (#1473): un defecto distinto aquí haría nacer la pantalla creyendo que el check
    // está sin guardar.
    countImmobilized: savedFieldValues.immobilizedCounts,
    monthlySavingsCapacity: savedFieldValues.monthlySavingsCapacity ?? "",
    monthlySpending: savedFieldValues.monthlySpending ?? "",
    safeWithdrawalRate: savedFieldValues.safeWithdrawalRate,
    // Lo guardado, para que tocar el `select` cuente como cambio sin guardar (#1520).
    spendingIncludesDebtService: savedFieldValues.spendingIncludesDebtService,
    targetRetirementAge: savedFieldValues.targetRetirementAge ?? "",
  };

  // Monthly allocation view (#557): the plan's capital split for a window of
  // months, every month server-rendered once; the island toggles client-side.
  const allocationWindow = allocationMonthKeys(today);
  const allocationDefaultMonth = allocationWindow[1] ?? today.slice(0, 7);
  const unitPrices = unitPriceMajorByHoldingId(priceCache);
  const monthlyAllocations =
    contributionPlan && contributionPlan.contributions.length > 0
      ? allocationWindow.map((monthKey) =>
          computeMonthlyContributionAllocation({
            plan: contributionPlan,
            monthKey,
            today,
            unitPriceMajorByHoldingId: unitPrices,
            reconciliations: contributionReconciliations,
            operations: contributionOperations,
          }),
        )
      : null;

  const contributionProjection = contributionPlan
    ? projectContributionReconciliation({
        plan: contributionPlan,
        fromDate:
          contributionPlan.contributions.map((item) => item.startDate).sort()[0] ?? today,
        toDate: new Date(Date.parse(`${today}T00:00:00Z`) + 90 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        today,
        reconciliations: contributionReconciliations,
        operations: contributionOperations,
      })
    : null;

  // Cupo anual de aportación (#1427): el tope lo declaró el usuario; lo consumido
  // sale del libro de operaciones del año natural en curso — nunca de lo que el
  // plan preveía aportar, que induciría a pasarse creyendo que queda margen.
  //
  // Y lo consumido sale de los planes de pensiones del alcance, vivos o en la
  // papelera (#1509, #1567): un plan traspasado se vacía y se manda a la papelera,
  // y sus aportaciones de este año siguen habiendo consumido cupo. Un fondo
  // marcado en un snapshot viejo no cuenta, ni vivo ni en la papelera. Un PP
  // dado de alta después del último save cuenta porque los destinos se
  // re-derivan del instrumento en cada lectura.
  const liveHoldingIds = new Set(assets.map((asset) => asset.id));
  const trashedHoldings =
    contributionAllowances.length > 0 ? (await store.readTrash()).assets : [];
  const derivedAllowances = contributionAllowances.map((allowance) =>
    withDerivedAllowanceDestinations(allowance, [
      ...assets,
      ...trashedHoldings.map(trashAssetToHolding),
    ]),
  );
  const allowanceOperations = contributionAllowanceOperations({
    allowances: derivedAllowances,
    liveHoldingIds,
    liveOperations: contributionOperations,
    operationsByAsset: projectionContext.operationsByAsset,
  });
  const allowanceUsageById = new Map(
    derivedAllowances.map((allowance) => [
      allowance.id,
      computeContributionAllowanceUsage({
        allowance,
        currency,
        operations: allowanceOperations,
        todayISO: today,
      }),
    ]),
  );
  const allowanceDestinationOptions = contributionAllowanceDestinationOptions(assets);
  // Los nombres incluyen los de la papelera: un destino cuyas aportaciones SÍ se
  // cuentan tiene que poder nombrarse, o el panel lo tacharía de invisible (#1509).
  const holdingNameById = new Map([
    ...assets.map((asset): [string, string] => [asset.id, asset.name]),
    ...trashedHoldings.map((holding): [string, string] => [holding.id, holding.name]),
  ]);
  const trashedHoldingIds = new Set(trashedHoldings.map((holding) => holding.id));

  // Passive-income lens (#658): the selected scope's trailing-12m payouts,
  // weighted by ownership, against declared spending. Server-rendered figures;
  // coverage is shown only when spending is known.
  const passiveIncome: PassiveIncomeLens | null = selectedScope
    ? scopePassiveIncome({
        payoutsByHolding,
        holdings: assets,
        scopeMemberIds: new Set(resolveScopeMemberIds(workspace, selectedScope.id)),
        monthlySpendingMinor: fireScopeConfig?.monthlySpendingMinor ?? null,
        todayISO: today,
      })
    : null;

  const assumedAnnualReturn = fireResult?.context.realReturnUsed ?? 0.05;
  const exposureDriftHorizon =
    fireProjection?.scenarios.find((scenario) => scenario.label === "base")
      ?.yearsToFire ?? 20;
  const exposureDriftPlan =
    contributionPlan && selectedScope && contributionPlan.contributions.length > 0
      ? { plan: contributionPlan, scope: selectedScope }
      : null;
  let holdingReturnsById = new Map<string, HoldingReturnsView | null>();
  if (exposureDriftPlan) {
    const instrumentByAsset = new Map(
      assets.map((asset) => [asset.id, instrumentOfAsset(asset)]),
    );
    const monthlyClosesByAsset = monthlyCloseValuesByHolding(
      returnSnapshotRows.filter((row) =>
        projectionContext.operationsByAsset.has(row.holdingId),
      ),
    );
    const payoutsByAsset = new Map(
      [...payoutsByHolding].map(([assetId, rows]) => [
        assetId,
        rows.map((row) => ({ amountMinor: row.amountMinor, date: row.dateISO })),
      ]),
    );
    const investmentReturns = investmentReturnsById({
      cachedPriceByAsset: projectionContext.cachedPriceByAsset,
      currency: workspace.baseCurrency,
      instrumentByAsset,
      manualPriceByAsset: projectionContext.manualPriceByAsset,
      monthlyClosesByAsset,
      operationsByAsset: projectionContext.operationsByAsset,
      payoutsByAsset,
      valuationDate: today,
    });
    holdingReturnsById = new Map<string, HoldingReturnsView | null>(
      [...investmentReturns].map(([assetId, view]) => [assetId, view]),
    );
  }
  const exposureDriftTrajectories = exposureDriftPlan
    ? buildExposureDriftTrajectories({
        workspace,
        scope: exposureDriftPlan.scope,
        assets,
        liabilities,
        investmentMeta,
        exposureProfiles,
        contributionPlan: exposureDriftPlan.plan,
        assumedAnnualReturn,
        holdingReturnsById,
        unitPrices,
        today,
        maxYears: exposureDriftHorizon,
      })
    : null;

  return {
    ...state,
    ageSource,
    allocationDefaultMonth,
    allocationWindow,
    allowanceDestinationOptions,
    allowanceUsageById,
    assets,
    contributionOperations,
    contributionPlan,
    contributionProjection,
    derivedAllowances,
    exposureDriftTrajectories,
    holdingNameById,
    monthlyAllocations,
    passiveIncome,
    publicIdByAssetId,
    savedDraft,
    savingsSuggestion,
    seededFromPlan,
    trashedHoldingIds,
    unitPrices,
  };
}
