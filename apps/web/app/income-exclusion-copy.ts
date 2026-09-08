import type { IncomeExclusionReason } from "@worthline/domain";

/** The same reason beside a declaration and every figure that withholds it. */
export const INCOME_EXCLUSION_COPY: Record<IncomeExclusionReason, string> = {
  missing_nature: "Naturaleza sin declarar: esta renta no cuenta en las cifras.",
  work_income: "Renta del trabajo: no cuenta como renta pasiva.",
  missing_amount_basis:
    "Importe sin declarar como real o nominal: esta renta no cuenta en las cifras.",
  nominal_amount:
    "Importe nominal: esta renta no se cuenta como euros de hoy en las cifras.",
};
