import type { FireScopeConfig } from "./fire";
import {
  calculateFireForScope,
  fireCountsImmobilizedCapital,
  fireReservationHorizon,
  isFireEligibleAsset,
  projectFireFamilyFromContext,
  projectFireFromContext,
} from "./fire";
import type { FireAchievement } from "./fire-achievement";
import { fireAchievement } from "./fire-achievement";
import type { FireCoastArrival } from "./fire-coast-arrival";
import { fireCoastArrival } from "./fire-coast-arrival";
import type { FireLevel } from "./fire-levels";
import { fireLevelAmounts, fireLevels } from "./fire-levels";
import type { FireProjection } from "./fire-projection";
import type { FireRetirementProfile } from "./fire-retirement-profile";
import { fireRetirementReadout } from "./fire-retirement-readout";
import { monthlySavingsCapacityForFire } from "./fire-savings-capacity";
import type { FireSustainableSpending } from "./fire-sustainable-spending";
import type { FxAggregation } from "./fx";
import type { GoalFireDelay } from "./goal-fire-delay";
import { goalFireDelay } from "./goal-fire-delay";
import type { Goal } from "./goals";
import {
  assignedHoldingsValueMinor,
  goalFundedRatioBps,
  goalReservedMinor,
  totalGoalReservationMinor,
} from "./goals";
import type { InvestmentOperation, PositionSummary } from "./investment-types";
import type {
  LiquidityTierBreakdown,
  NetWorthFraming,
  NetWorthPresentation,
  NetWorthSummary,
} from "./net-worth";
import { buildLiquidityBreakdown, calculateNetWorth, presentNetWorth } from "./net-worth";
import type { PayoutSchedule } from "./payouts";
import type { LocalPersistenceStatus } from "./persistence";
import type { AssetPrice } from "./prices";
import type { SavingsCoherence } from "./savings-coherence";
import { scopeSavingsCoherence } from "./savings-coherence";
import type { ScopeOption } from "./scope";
import { resolveScopeMemberIds } from "./scope";
import { scopeOwnedHoldingIds } from "./scope-holdings";
import type { NetWorthSnapshot, SnapshotDeltas } from "./snapshot-types";
import { calculateSnapshotDeltas } from "./snapshot-types";
import type { SpendingDebtServiceCoherence } from "./spending-debt-service";
import { scopeSpendingDebtService } from "./spending-debt-service";
import type { Liability, ManualAsset, Member, Workspace } from "./workspace-types";

export type { LocalPersistenceStatus };

export interface DashboardShell {
  productName: "worthline";
  baseCurrency: "EUR";
  generatedAt: string;
  persistence: LocalPersistenceStatus;
}

export interface PositionView extends PositionSummary {
  name: string;
}

/**
 * Converts an array of raw values (e.g. bps counts) into integer percentages
 * that sum to exactly 100 using the Largest Remainder Method.
 * Preserves input order. All-zero inputs return all zeros.
 */
export function largestRemainderPercentages(values: number[]): number[] {
  if (values.length === 0) return [];

  const total = values.reduce((sum, v) => sum + v, 0);

  if (total === 0) return values.map(() => 0);

  const floats = values.map((v) => (v / total) * 100);
  const floors = floats.map((f) => Math.floor(f));
  const remainders = floats.map((f, i) => f - floors[i]!);
  const deficit = 100 - floors.reduce((a, b) => a + b, 0);

  // Sort indices by remainder descending, allocate the deficit 1-by-1.
  const order = remainders
    .map((r, i) => ({ i, r }))
    .sort((a, b) => b.r - a.r)
    .map((x) => x.i);

  for (let k = 0; k < deficit; k++) {
    floors[order[k]!]! += 1;
  }

  return floors;
}

export interface OnboardingStep {
  id: string;
  label: string;
  done: boolean;
}

/**
 * The ordered "first steps" a new workspace should complete, each marked done
 * from the current counts. Pure — drives the first-run checklist and the
 * empty-state guidance.
 */
export function deriveOnboardingProgress(input: {
  activeMemberCount: number;
  holdingCount: number;
  hasFireConfig: boolean;
  snapshotCount: number;
}): OnboardingStep[] {
  return [
    { id: "members", label: "Revisa los miembros", done: input.activeMemberCount > 0 },
    {
      id: "holdings",
      label: "Añade tu primer holding",
      done: input.holdingCount > 0,
    },
    { id: "fire", label: "Configura FIRE", done: input.hasFireConfig },
    {
      id: "snapshot",
      label: "Tu primer snapshot se captura automáticamente",
      done: input.snapshotCount > 0,
    },
  ];
}

/**
 * Compact summary of FIRE state for the home glance card (PRD #507, S1).
 * All values derived from `fireResult` + `fireProjection` + goals reservation —
 * no new projection math here.
 */
export interface FireGlance {
  /** 0–100+, matches `FireResult.percentFunded`. */
  percentFunded: number;
  /** coastRequired / fireNumber (0–1); null when coast data is unavailable. */
  coastTickFraction: number | null;
  /**
   * The achievement badge and whether it is vetoed by measured dis-saving
   * (#1449). Replaces the raw `isFunded` / `isAlreadyAtCoastFire` pair the card
   * used to branch on, so the veto cannot be applied on one screen and forgotten
   * on the other.
   */
  achievement: FireAchievement;
  /** Whole years to FIRE from the base scenario; null if beyond the horizon. */
  yearsToFire: number | null;
  /** Number of active goals for the scope. */
  goalsCount: number;
  /** Total capital reserved for goals (minor units). */
  goalsReservedMinor: number;
}

export interface DashboardState {
  persistence: LocalPersistenceStatus;
  workspace: Workspace | null;
  assets: ManualAsset[];
  liabilities: Liability[];
  positions: PositionView[];
  priceCache: AssetPrice[];
  scopes: ScopeOption[];
  selectedScope: ScopeOption | undefined;
  snapshots: NetWorthSnapshot[];
  summary: NetWorthSummary | undefined;
  presentation: NetWorthPresentation | undefined;
  fireScopeConfig: FireScopeConfig | null;
  fireResult: ReturnType<typeof calculateFireForScope> | null;
  /**
   * El mismo ámbito con la declaración del inmovilizado invertida (#1473) — el
   * contrafactual que `previewFireWithAssumptions` necesita para que alternar el check
   * responda en vivo sin escribir una segunda aritmética en el cliente. Sale del MISMO
   * motor, con la misma reserva de metas y el mismo reloj, así que previsualizar y
   * guardar no pueden discrepar.
   *
   * Null salvo que el llamador lo pida (`includeFireImmobilizedCounterfactual`): solo
   * la pantalla que previsualiza paga por el segundo cálculo.
   */
  fireResultImmobilizedFlipped: ReturnType<typeof calculateFireForScope> | null;
  /** FIRE projection scenarios (PRD #421, #427); null when FIRE is unconfigured. */
  fireProjection: FireProjection | null;
  /** Compact glance data for the home FIRE card (PRD #507, S1); null when unconfigured. */
  fireGlance: FireGlance | null;
  /**
   * Declared-vs-measured savings for the selected scope (#1449). Null when FIRE is
   * unconfigured or the caller handed in no ledger to measure.
   */
  savingsCoherence: SavingsCoherence | null;
  /**
   * El gasto declarado contra el servicio de deuda vigente (#1520). Null cuando FIRE
   * está sin configurar o el llamador no pasó las cuotas: sin ellas no hay testigo, y
   * un cero inventado diría «no tienes deudas» donde lo cierto es «no hemos mirado».
   */
  debtServiceCoherence: SpendingDebtServiceCoherence | null;
  selectedMemberIds: string[];
  pyramid: LiquidityTierBreakdown[];
  deltas: SnapshotDeltas | undefined;
  dashboard: DashboardShell;
  activeMembers: Member[];
  investmentAssets: ManualAsset[];
  today: string;
  onboarding: OnboardingStep[];
  selectedView: NetWorthFraming;
}

export function prepareDashboardState(input: {
  persistence: LocalPersistenceStatus;
  workspace: Workspace | null;
  assets: ManualAsset[];
  liabilities: Liability[];
  positions: PositionView[];
  priceCache: AssetPrice[];
  scopes: ScopeOption[];
  selectedScope: ScopeOption | undefined;
  snapshots: NetWorthSnapshot[];
  fireConfig: Record<string, FireScopeConfig>;
  selectedView: NetWorthFraming;
  /** Goals for the selected scope (PRD #421, #426); reserve capital against FIRE. */
  goals?: Goal[];
  /**
   * Hoy (YYYY-MM-DD): el horizonte de reserva de metas y la validez de las rentas se
   * miden contra este día. **Obligatorio** (#1597, ADR 0024) — el dominio no lee el
   * reloj, y un defecto de sistema aquí ponía una segunda fecha delante de la misma
   * pantalla.
   */
  today: string;
  /**
   * FX context for non-base-currency holdings (#1065). Present only when the
   * portfolio actually holds a foreign currency (the caller resolves ECB rates
   * lazily); absent for an all-EUR portfolio, in which case nothing is converted
   * or excluded. Threaded into net worth and the liquidity breakdown so both
   * agree on which holdings the total covers.
   */
  fx?: FxAggregation;
  /**
   * The investment ledger keyed by holding id — the evidence the achievement-badge
   * veto reads (#1449). Optional because a caller with no FIRE config on screen has
   * nothing to veto; when absent, the badge behaves exactly as it did before. Both
   * page loads that draw the badge already hold this map (the shared projection
   * context), so passing it costs no I/O.
   */
  investmentOperationsByAssetId?: ReadonlyMap<string, readonly InvestmentOperation[]>;
  /**
   * La cuota vigente de cada deuda al 100 %, derivada por `debtServiceAtDate` (#1520).
   * Opcional: solo la pide la pantalla que nombra el supuesto del gasto declarado, y
   * derivarla exige leer el plan, sus revisiones y sus amortizaciones de cada deuda —
   * I/O que ninguna otra superficie necesita.
   */
  debtServiceByLiabilityId?: ReadonlyMap<string, number>;
  /**
   * Declared payout schedules (#1448) — the evidence behind the rent-derived FIRE
   * rate. Optional: without them the rate is the tier weighting it always was.
   * Every screen that draws a FIRE figure already reads these for its payout
   * surfaces, so passing them costs no I/O.
   */
  payoutSchedules?: readonly PayoutSchedule[];
  /**
   * Calcular también el ámbito con la declaración del inmovilizado invertida (#1473).
   * Lo pide la pantalla que previsualiza supuestos en vivo; para el resto sería un
   * segundo `calculateFireForScope` que nadie lee.
   */
  includeFireImmobilizedCounterfactual?: boolean;
  /**
   * Compute the FIRE chart projection. /objetivos skips this and uses one
   * `projectFireFamilyFromContext` so chart, rail, coast and goals share a
   * single growth loop (#1537). Default true — the home glance still needs it.
   */
  includeFireProjection?: boolean;
  /**
   * Compute net-worth summary, presentation, pyramid, deltas and onboarding.
   * /objetivos throws these away (#1537). Default true for the dashboard.
   */
  includeNetWorthSurfaces?: boolean;
}): DashboardState {
  const { workspace, assets, liabilities, selectedScope, persistence } = input;
  const today = input.today;
  const includeFireProjection = input.includeFireProjection !== false;
  const includeNetWorthSurfaces = input.includeNetWorthSurfaces !== false;

  const summary =
    includeNetWorthSurfaces && workspace && selectedScope
      ? calculateNetWorth({
          assets,
          ...(input.fx ? { fx: input.fx } : {}),
          liabilities,
          scopeId: selectedScope.id,
          workspace,
        })
      : undefined;

  const presentation = summary ? presentNetWorth(summary, input.selectedView) : undefined;

  const fireScopeConfig: FireScopeConfig | null = selectedScope
    ? (input.fireConfig[selectedScope.id] ?? null)
    : null;

  const fireReservedMinor =
    fireScopeConfig && workspace && selectedScope
      ? (() => {
          const memberIds = new Set(resolveScopeMemberIds(workspace, selectedScope.id));
          const assetById = new Map(assets.map((asset) => [asset.id, asset]));
          return totalGoalReservationMinor(
            (input.goals ?? []).map((goal) => ({
              targetAmountMinor: goal.targetAmountMinor,
              deadline: goal.deadline,
              assignedValueMinor: assignedHoldingsValueMinor(
                goal.assetIds,
                assetById,
                memberIds,
                (asset) => isFireEligibleAsset(asset, fireScopeConfig),
              ),
            })),
            today,
            fireReservationHorizon(fireScopeConfig, today),
          );
        })()
      : 0;

  // Una sola puerta al motor para los dos lados de la declaración del inmovilizado
  // (#1473): el contrafactual entra por aquí con la MISMA reserva, el mismo reloj y
  // las mismas rentas, así que el lado que la isla previsualiza es exactamente el que
  // dejará el guardado.
  const fireForConfig = (config: FireScopeConfig) =>
    workspace && selectedScope
      ? calculateFireForScope(
          config,
          assets,
          liabilities,
          workspace,
          selectedScope.id,
          fireReservedMinor,
          // Same "today" as the reservation horizon above: a schedule's validity
          // must not be measured on a second clock (#1448).
          input.payoutSchedules
            ? { rents: { schedules: input.payoutSchedules, todayISO: today } }
            : {},
        )
      : null;

  const fireResult = fireScopeConfig ? fireForConfig(fireScopeConfig) : null;

  const fireResultImmobilizedFlipped =
    fireScopeConfig && input.includeFireImmobilizedCounterfactual
      ? fireForConfig({
          ...fireScopeConfig,
          immobilizedCountsAsFireCapital: !fireCountsImmobilizedCapital(fireScopeConfig),
        })
      : null;

  // FIRE projection (#427): scenarios from the reservation-adjusted eligible
  // total and the configured monthly savings capacity. The resolved rate, FIRE
  // number and age ride in the context (#1026), so coast + projection + levels
  // agree by construction — no rate to thread by hand, no fallback. The savings
  // capacity is the declared scalar and nothing else (#1416, ADR 0074): the
  // contribution plan used to override it here, substituting one destination's
  // planned addition for the user's declared total.
  const fireProjection =
    includeFireProjection && fireResult
      ? projectFireFromContext(fireResult.context, {
          monthlyContributionMinor: monthlySavingsCapacityForFire(
            fireResult.context.config,
          ),
        })
      : null;

  const selectedMemberIds =
    workspace && selectedScope ? resolveScopeMemberIds(workspace, selectedScope.id) : [];

  const pyramid =
    includeNetWorthSurfaces && workspace && selectedScope
      ? buildLiquidityBreakdown({
          assets,
          ...(input.fx ? { fx: input.fx } : {}),
          liabilities,
          scopeId: selectedScope.id,
          workspace,
        })
      : [];

  const latestSnapshot = input.snapshots.at(-1);
  const deltas =
    includeNetWorthSurfaces && latestSnapshot
      ? calculateSnapshotDeltas(input.snapshots, latestSnapshot.id)
      : undefined;

  const dashboard: DashboardShell = {
    productName: "worthline",
    baseCurrency: "EUR",
    generatedAt: persistence.checkedAt,
    persistence,
  };

  const activeMembers = workspace?.members.filter((member) => !member.disabledAt) ?? [];
  const investmentAssets = assets.filter((asset) => asset.type === "investment");
  const onboarding = includeNetWorthSurfaces
    ? deriveOnboardingProgress({
        activeMemberCount: activeMembers.length,
        holdingCount: assets.length + liabilities.length,
        hasFireConfig: fireScopeConfig !== null,
        snapshotCount: input.snapshots.length,
      })
    : [];

  // Declared-vs-measured savings (#1449): the same reading the health engine
  // alerts on, over the same scope-owned holdings — so the badge on screen and
  // the alert above it can never disagree about what the ledger measures.
  const savingsCoherence: SavingsCoherence | null =
    fireScopeConfig && workspace && selectedScope && input.investmentOperationsByAssetId
      ? scopeSavingsCoherence({
          asOfDateKey: today,
          config: fireScopeConfig,
          currency: workspace.baseCurrency,
          operationsByAssetId: input.investmentOperationsByAssetId,
          ownedHoldingIds: scopeOwnedHoldingIds({
            assets,
            liabilities,
            scopeOption: selectedScope,
            workspace,
          }),
        })
      : null;

  // El gasto declarado contra la cuota que la app ya sabe (#1520): el mismo careo
  // que emite la señal de salud, sobre las mismas deudas del ámbito — así la glosa de
  // las tarjetas y el aviso del inventario no pueden citar cuotas distintas.
  const debtServiceCoherence: SpendingDebtServiceCoherence | null =
    fireScopeConfig && workspace && selectedScope && input.debtServiceByLiabilityId
      ? scopeSpendingDebtService({
          config: fireScopeConfig,
          currency: workspace.baseCurrency,
          debtServiceByLiabilityId: input.debtServiceByLiabilityId,
          liabilities,
          scopeMemberIds: new Set(resolveScopeMemberIds(workspace, selectedScope.id)),
        })
      : null;

  const fireGlance: FireGlance | null =
    fireScopeConfig && fireResult
      ? {
          percentFunded: fireResult.percentFunded,
          coastTickFraction:
            fireResult.coastFireRequired && fireResult.fireNumber.amountMinor > 0
              ? Math.min(
                  1,
                  fireResult.coastFireRequired.amountMinor /
                    fireResult.fireNumber.amountMinor,
                )
              : null,
          achievement: fireAchievement({
            ...(fireResult.isAlreadyAtCoastFire === undefined
              ? {}
              : { isAlreadyAtCoastFire: fireResult.isAlreadyAtCoastFire }),
            ...(savingsCoherence === null ? {} : { coherence: savingsCoherence }),
            percentFunded: fireResult.percentFunded,
          }),
          yearsToFire:
            fireProjection?.scenarios.find((s) => s.label === "base")?.yearsToFire ??
            null,
          goalsCount: (input.goals ?? []).length,
          goalsReservedMinor: fireResult.reservedForGoals?.amountMinor ?? 0,
        }
      : null;

  return {
    activeMembers,
    assets,
    dashboard,
    debtServiceCoherence,
    deltas,
    fireGlance,
    fireProjection,
    fireResult,
    fireResultImmobilizedFlipped,
    fireScopeConfig,
    investmentAssets,
    liabilities,
    onboarding,
    persistence,
    positions: input.positions,
    presentation,
    priceCache: input.priceCache,
    pyramid,
    savingsCoherence,
    scopes: input.scopes,
    selectedMemberIds,
    selectedScope,
    selectedView: input.selectedView,
    snapshots: input.snapshots,
    summary,
    today,
    workspace,
  };
}

/** Shape returned by `prepareObjetivosState`. */
export interface ObjetivosGoalView {
  goal: Goal;
  /** Basis points funded (0–10 000), via `goalFundedRatioBps`. */
  fundedRatioBps: number;
  /** Capital reserved in minor units, via `goalReservedMinor`. */
  reservedMinor: number;
  /**
   * True when this goal's deadline is still in the future AND before the FIRE
   * horizon — i.e. its reservation actually reduces the FIRE-eligible total.
   * Uses the same filter as `totalGoalReservationMinor`.
   */
  countsTowardFire: boolean;
  /**
   * How many months this goal delays the FIRE date (PRD #507, S4 #512).
   * Computed by `goalFireDelay` — the 4th reservation consumer. Marginal:
   * measured against the WITHOUT scenario where other goals are already reserved.
   */
  fireDelay: GoalFireDelay;
}

export interface ObjetivosState {
  fireProjection: DashboardState["fireProjection"];
  fireResult: DashboardState["fireResult"];
  /**
   * El otro lado de la declaración del inmovilizado (#1473). Esta página lo pide
   * siempre porque su isla previsualiza el check como los cuatro campos de al lado, y
   * elegir lado exige tener el lado. Null sin config FIRE.
   */
  fireResultImmobilizedFlipped: DashboardState["fireResultImmobilizedFlipped"];
  fireScopeConfig: DashboardState["fireScopeConfig"];
  /** coastRequired / fireNumber clamped to [0,1]; null when coast data unavailable. */
  coastTickFraction: number | null;
  /**
   * When the scope reaches Coast projecting WITH its declared savings (#1425). The tick
   * on the bar always implied a date and nothing computed one: the only age the screen
   * had assumed contributions of zero. Null when there is no coast requirement to cross
   * at all — no age configured, or no compounding room left before the target age (ADR
   * 0079) — which is NOT the same as `unreachable`.
   */
  coastArrival: FireCoastArrival | null;
  /**
   * The achievement badge for the hero, veto included (#1449). Read off the same
   * `fireAchievement` the home card reads, so "FIRE alcanzado" cannot be a claim
   * on one screen and a caveat on the other. Null when FIRE is unconfigured.
   */
  achievement: FireAchievement | null;
  /**
   * Declared-vs-measured savings for the scope (#1449). The FIRE panel is where
   * the divergence gets shown to a human: the health engine keeps it in the shared
   * inventory, but the figures it puts in doubt (the FIRE date, the funded
   * percentage) live here. Null when FIRE is unconfigured or no ledger was handed in.
   */
  savingsCoherence: SavingsCoherence | null;
  /**
   * El gasto declarado contra el servicio de deuda vigente (#1520). Las dos tarjetas
   * que contestan en €/mes —la cobertura del gasto y el gasto sostenible— nombran con
   * esto el supuesto bajo el que están hablando, el de «sin declarar» incluido. No
   * mueve ninguna cifra. Null sin config FIRE o sin cuotas pasadas.
   */
  debtServiceCoherence: SpendingDebtServiceCoherence | null;
  goals: ObjetivosGoalView[];
  /**
   * Coast · Lean · Regular · Fat milestones (PRD #507 N1, #513).
   * Null when no FIRE config is available for the scope.
   */
  fireLevelRail: FireLevel[] | null;
  /**
   * ¿El plan de este ámbito es FIRE o una jubilación ordinaria? (#1428, ADR 0081.)
   * Decide qué pregunta lidera la pantalla, nunca ninguna cifra. Null sin config FIRE.
   */
  retirementProfile: FireRetirementProfile | null;
  /**
   * «¿Cuánto puedo gastar sin mermar mi patrimonio?» — la inversa de la fórmula FIRE
   * (#1428). Se calcula siempre que haya con qué, porque es una cifra honesta para
   * cualquier perfil: el estado de arriba solo decide si es el titular. Null sin
   * config FIRE, o cuando no hay tasa de retirada con la que dividir.
   */
  sustainableSpending: FireSustainableSpending | null;
}

/**
 * Pure state for the /objetivos page (PRD #507, S2 #510).
 * Composes `prepareDashboardState` for all FIRE data, then layers per-goal
 * funded/reserved views using the existing `goalFundedRatioBps` /
 * `goalReservedMinor` helpers. No projection math is duplicated here.
 */
export function prepareObjetivosState(
  input: Parameters<typeof prepareDashboardState>[0],
): ObjetivosState {
  // El contrafactual del inmovilizado se pide aquí y no en la página (#1473): quien
  // sabe que esta pantalla previsualiza sus supuestos es esta puerta, no su llamador.
  const dash = prepareDashboardState({
    ...input,
    includeFireImmobilizedCounterfactual: true,
    includeFireProjection: false,
    includeNetWorthSurfaces: false,
  });

  const { workspace, selectedScope } = dash;
  const assetById = new Map(input.assets.map((a) => [a.id, a]));
  const scopeMemberIds: Set<string> =
    workspace && selectedScope
      ? new Set(resolveScopeMemberIds(workspace, selectedScope.id))
      : new Set();

  const now = input.today;
  const fireHorizon = dash.fireScopeConfig
    ? fireReservationHorizon(dash.fireScopeConfig, now)
    : undefined;

  // Per-goal in-horizon reservation map: only goals whose deadline is future + before horizon.
  const goalReservationMap = new Map<string, number>();
  for (const goal of input.goals ?? []) {
    const assignedMinor = dash.fireScopeConfig
      ? assignedHoldingsValueMinor(goal.assetIds, assetById, scopeMemberIds, (asset) =>
          isFireEligibleAsset(asset, dash.fireScopeConfig!),
        )
      : 0;
    const inHorizon =
      goal.deadline >= now && (fireHorizon === undefined || goal.deadline < fireHorizon);
    goalReservationMap.set(
      goal.id,
      inHorizon ? goalReservedMinor(goal.targetAmountMinor, assignedMinor) : 0,
    );
  }
  const totalReservation = [...goalReservationMap.values()].reduce((s, v) => s + v, 0);

  const amounts = dash.fireResult
    ? fireLevelAmounts(dash.fireResult.context.config)
    : null;
  const family = dash.fireResult
    ? projectFireFamilyFromContext(dash.fireResult.context, {
        monthlyContributionMinor: monthlySavingsCapacityForFire(
          dash.fireResult.context.config,
        ),
        horizonTargetMinor: amounts?.fatMinor ?? dash.fireResult.context.fireNumberMinor,
      })
    : null;

  const goals: ObjetivosGoalView[] = (input.goals ?? []).map((goal) => {
    const assignedMinor = assignedHoldingsValueMinor(
      goal.assetIds,
      assetById,
      scopeMemberIds,
    );
    const inHorizon =
      goal.deadline >= now && (fireHorizon === undefined || goal.deadline < fireHorizon);
    const countsTowardFire = inHorizon && (goalReservationMap.get(goal.id) ?? 0) > 0;
    // otherReservationsMinor = total in-horizon reservation minus this goal's share.
    const otherReservationsMinor =
      totalReservation - (goalReservationMap.get(goal.id) ?? 0);
    return {
      goal,
      fundedRatioBps: goalFundedRatioBps(goal.targetAmountMinor, assignedMinor),
      reservedMinor: goalReservedMinor(goal.targetAmountMinor, assignedMinor),
      countsTowardFire,
      fireDelay: dash.fireResult
        ? goalFireDelay({
            context: dash.fireResult.context,
            goal,
            otherReservationsMinor,
            thisGoalReservationMinor: goalReservationMap.get(goal.id) ?? 0,
            now,
            ...(family ? { withProjection: family.chart } : {}),
          })
        : { kind: "no_effect" as const },
    };
  });

  // fireLevels reads the net eligible + resolved rate straight from the context
  // (#1026), so rail ETAs are coherent with the projection chart and coast by
  // construction — the context carries the SAME net eligible the chart starts from.
  const fireLevelRail = dash.fireResult
    ? fireLevels({
        context: dash.fireResult.context,
        ...(family ? { projection: family.rail } : {}),
      })
    : null;

  // Perfil y gasto sostenible por una sola puerta (#1428): el perfil se mide contra
  // ESTE rail, el mismo que la pantalla pinta.
  const retirement = dash.fireResult
    ? fireRetirementReadout({ levels: fireLevelRail, result: dash.fireResult })
    : null;

  return {
    achievement: dash.fireGlance?.achievement ?? null,
    // La edad de llegada a Coast (#1425): sale del MISMO contexto que el rail y el
    // gráfico, así que las tres cifras no pueden discrepar sobre cuánto se aporta.
    coastArrival: dash.fireResult
      ? fireCoastArrival(dash.fireResult.context, {
          fireResult: dash.fireResult,
          ...(family ? { projection: family.chart } : {}),
        })
      : null,
    coastTickFraction: dash.fireGlance?.coastTickFraction ?? null,
    debtServiceCoherence: dash.debtServiceCoherence,
    savingsCoherence: dash.savingsCoherence,
    fireProjection: family?.chart ?? null,
    fireResult: dash.fireResult,
    fireResultImmobilizedFlipped: dash.fireResultImmobilizedFlipped,
    fireScopeConfig: dash.fireScopeConfig,
    goals,
    fireLevelRail,
    retirementProfile: retirement?.profile ?? null,
    sustainableSpending: retirement?.spending ?? null,
  };
}
