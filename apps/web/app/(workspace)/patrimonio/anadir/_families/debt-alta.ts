/**
 * The alta of a deuda (#1611): the family that creates a liability plus the debt
 * model deciding how its balance is valued (ADR 0031).
 *
 * Three things live here and nowhere else:
 *
 * - **The model.** A `loan` lets the user choose «Amortizable» or «Informal» at
 *   creation (#273); mortgage and credit_card keep the fixed model the catalog
 *   assigns. The model is part of the alta, not of a later edit, because it is
 *   what gives the holding its valuation method from birth.
 * - **«Alta por estado actual»** (ADR 0056, #677): the simple wizard's debt
 *   drawer offers it as the DEFAULT path for an amortizable mortgage/loan —
 *   today's outstanding balance, the end date, and either the cuota or the rate —
 *   and derives the plan from them.
 * - **Inherited ownership** (#171): a debt associated to an asset copies that
 *   asset's split once, at creation. Resolved server-side because the add page
 *   carries no client JS (ADR 0009).
 */

import {
  mapDomainViolation,
  parseLiabilityCommand,
  parseMoneyMinorField,
} from "@web/intake";
import { deriveCurrentStateDebt } from "@web/patrimonio/current-state-debt";
import { buildCurrentStateAmortization } from "@web/patrimonio/persist-current-state-debt";
import type { DebtModel, LiabilityDefaults, LiabilityType } from "@worthline/domain";
import { createLiabilitySafe } from "@worthline/domain";
import type { AltaContext, AltaResult } from "./alta-contract";
import { carry, carryOwnership, SHARED_REFILL_FIELDS } from "./alta-form";

/** What the deuda pane posts and gets back after a rejected alta. */
export const DEBT_REFILL_FIELDS: readonly string[] = [
  ...SHARED_REFILL_FIELDS,
  "balance",
  "assoc",
  "inheritOwnership",
  "debtModel",
];

/** The catalog facts the routing already resolved for this family. */
export type DebtAltaSpec = LiabilityDefaults;

/**
 * The debt model a `loan` is created with (#273). Defaults to amortizable when
 * the choice is absent or unrecognized, preserving the pre-#273 behavior.
 */
function parseLoanDebtModel(formData: FormData): DebtModel {
  return String(formData.get("debtModel_loan") ?? "").trim() === "informal"
    ? "informal"
    : "amortizable";
}

/** Re-scope the unified form to the canonical names `parseLiabilityCommand` reads. */
function scopedLiabilityForm(ctx: AltaContext, type: LiabilityType): FormData {
  const scoped = new FormData();
  scoped.set("type", type);
  carry(ctx.formData, scoped, `name_${ctx.instrument}`, "name");
  carry(ctx.formData, scoped, `balance_${ctx.instrument}`, "balance");
  carry(ctx.formData, scoped, `assoc_${ctx.instrument}`, "associatedAssetId");
  carry(ctx.formData, scoped, `inheritOwnership_${ctx.instrument}`, "inheritOwnership");
  carryOwnership(ctx.formData, scoped);

  return scoped;
}

/**
 * Does the wizard's current-state block own the balance field for this alta?
 *
 * The CSS reveal (`anadir/page.tsx`) hides the plain «Saldo pendiente» for an
 * amortizable mortgage/loan in the simple drawer and shows the current-state
 * block instead, so `csOutstandingBalance` is the ONLY visible balance input for
 * them — it must always become the liability's balance, never gated on the end
 * date. Filling the end date on top additionally opts into persisting the plan;
 * leaving it blank keeps a plan-less creation with the current-state balance
 * intact («decide el modelo más tarde, en la ficha»).
 *
 * Gated on the DRAWER, not just the instrument, so the avanzado form — which has
 * no current-state fields and posts `balance_*` directly — is untouched.
 */
function currentStateOwnsBalance(ctx: AltaContext, debtModel: DebtModel): boolean {
  return (
    ctx.formData.get("simpleDrawer") === "deuda" &&
    (ctx.instrument === "mortgage" ||
      (ctx.instrument === "loan" && debtModel === "amortizable"))
  );
}

export async function runDebtAlta(
  ctx: AltaContext,
  spec: DebtAltaSpec,
): Promise<AltaResult> {
  const debtModel =
    ctx.instrument === "loan" ? parseLoanDebtModel(ctx.formData) : spec.debtModel;

  if (currentStateOwnsBalance(ctx, debtModel)) {
    // The one write this command makes to the submission, and it is deliberate:
    // a rejected alta must come back with the figure the user actually typed in
    // the visible field, so the refill reads it from here too.
    ctx.formData.set(
      `balance_${ctx.instrument}`,
      String(ctx.formData.get("csOutstandingBalance") ?? ""),
    );
  }

  const scoped = scopedLiabilityForm(ctx, spec.type);

  if (!String(scoped.get("name") ?? "").trim()) {
    return { ok: false, message: "El nombre de la deuda es obligatorio." };
  }

  if (parseMoneyMinorField(scoped, "balance") === null) {
    return { ok: false, message: "El saldo de la deuda no es válido." };
  }

  const currentState = readCurrentStateFields(ctx, debtModel);
  const derived = currentState
    ? deriveCurrentStateDebt({
        annualRatePercent: currentState.annualRatePercent,
        baselineDate: ctx.today,
        endDate: currentState.endDate,
        inputMode: currentState.inputMode,
        monthlyPayment: currentState.monthlyPayment,
        nextPaymentDate: currentState.nextPaymentDate,
        originalSigningDate: currentState.originalSigningDate,
        outstandingBalance: currentState.outstandingBalance,
      })
    : null;

  if (derived && !derived.ok) {
    return { ok: false, message: derived.error };
  }

  const workspace = await ctx.store.workspace.readWorkspace();

  if (!workspace) {
    return { ok: false, message: "Workspace no inicializado." };
  }

  const command = parseLiabilityCommand(scoped, workspace.members, ctx.seed);

  // #171: a debt associated to an asset inherits that asset's ownership split by
  // default — a one-time copy at creation, then independently editable (not a
  // live link, CONTEXT.md). The pre-checked «mismo reparto» drives it; unchecked
  // — or no asset associated — falls back to the footer ownership inputs.
  const inheritOwnership = scoped.get("inheritOwnership") === "on";
  const associatedAsset = command.associatedAssetId
    ? ((await ctx.store.assets.readAssets()).find(
        (a) => a.id === command.associatedAssetId,
      ) ?? null)
    : null;
  // A debt on a co-owned home mirrors the asset's split, which may be a known
  // partial (e.g. 75 % mine, 25 % a non-member's), so it accepts a partial split
  // exactly like the real_estate asset; a standalone debt still totals 100 %.
  const allowKnownPartial = associatedAsset?.type === "real_estate";
  const resolved =
    inheritOwnership && associatedAsset
      ? { ...command, ownership: associatedAsset.ownership }
      : command;

  const domainResult = createLiabilitySafe(workspace, resolved, { allowKnownPartial });

  if (!domainResult.ok) {
    return { ok: false, message: mapDomainViolation(domainResult.violations[0]) };
  }

  // ONE unit of work: the deuda, the model that decides how its balance is valued
  // (ADR 0031) and — on the «alta por estado actual» path — its plan and
  // re-baseline commit or roll back together (#1599). Before that seam they were
  // three calls, so a failure after the first left a deuda nobody could draw a
  // curve for.
  await ctx.store.command.createDebtHolding({
    debtModel,
    liability: resolved,
    today: ctx.today,
    ...(currentState && derived?.ok
      ? {
          currentState: buildCurrentStateAmortization(
            resolved.id,
            derived,
            {
              baselineDate: ctx.today,
              endDate: currentState.endDate,
              inputMode: currentState.inputMode,
              nextPaymentDate: currentState.nextPaymentDate,
              originalSigningDate: currentState.originalSigningDate || null,
            },
            ctx.seed,
          ),
        }
      : {}),
  });

  return { ok: true, created: { holdingId: resolved.id, okKey: "liability_added" } };
}

/** The current-state block, or null when this alta is not taking that path. */
function readCurrentStateFields(
  ctx: AltaContext,
  debtModel: DebtModel,
): {
  annualRatePercent: string;
  endDate: string;
  inputMode: "payment" | "rate";
  monthlyPayment: string;
  nextPaymentDate: string;
  originalSigningDate: string;
  outstandingBalance: string;
} | null {
  const endDate = String(ctx.formData.get("csEndDate") ?? "").trim();

  // The end date is what opts into the plan: without it the alta keeps the
  // current-state balance and no curve (the «origin path»).
  if (!currentStateOwnsBalance(ctx, debtModel) || endDate === "") {
    return null;
  }

  return {
    annualRatePercent: String(ctx.formData.get("csAnnualRate") ?? ""),
    endDate,
    inputMode: ctx.formData.get("csInputMode") === "payment" ? "payment" : "rate",
    monthlyPayment: String(ctx.formData.get("csMonthlyPayment") ?? ""),
    nextPaymentDate: String(ctx.formData.get("csNextPaymentDate") ?? "").trim(),
    originalSigningDate: String(ctx.formData.get("csOriginalSigningDate") ?? "").trim(),
    outstandingBalance: String(ctx.formData.get("csOutstandingBalance") ?? ""),
  };
}
