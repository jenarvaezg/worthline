import { parseMoneyMinor } from "@web/intake";
import {
  type ContributionCadence,
  normalizeDecimal,
  type PlannedContributionAmount,
} from "@worthline/domain";

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

export function parseContributionPlanForm(formData: FormData): {
  destinationHoldingId: string;
  amount: PlannedContributionAmount;
  cadence: ContributionCadence;
  startDate: string;
  endDate?: string;
} {
  const mode = field(formData, "mode");
  const rawAmount = field(formData, "amount");
  const amount: PlannedContributionAmount =
    mode === "units"
      ? { mode: "units", value: normalizeDecimal(rawAmount) }
      : (() => {
          const value = parseMoneyMinor(rawAmount);
          if (value === null) throw new Error("El importe planificado no es válido.");
          return { mode: "money" as const, value };
        })();
  const cadenceKind = field(formData, "cadence");
  const cadence: ContributionCadence =
    cadenceKind === "weekly"
      ? { kind: "weekly", weekday: Number(field(formData, "weekday")) as 1 }
      : cadenceKind === "quarterly"
        ? { kind: "quarterly" }
        : cadenceKind === "annual"
          ? { kind: "annual" }
          : { kind: "monthly", dayOfMonth: Number(field(formData, "dayOfMonth")) };
  const endDate = field(formData, "endDate");
  return {
    destinationHoldingId: field(formData, "destinationHoldingId"),
    amount,
    cadence,
    startDate: field(formData, "startDate"),
    ...(endDate ? { endDate } : {}),
  };
}
