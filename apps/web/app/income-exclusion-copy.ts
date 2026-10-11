import type { IncomeExclusionReason } from "@worthline/domain";

/** The same reason beside a declaration and every figure that withholds it. */
export const INCOME_EXCLUSION_COPY: Record<IncomeExclusionReason, string> = {
  missing_nature: "Naturaleza sin declarar: esta renta no cuenta en las cifras.",
  work_income: "Renta del trabajo: no cuenta como renta pasiva.",
  missing_amount_basis:
    "Importe sin declarar como real o nominal: esta renta no cuenta en las cifras.",
  // Un importe fijo a fecha futura no es real, y tratarlo como tal se equivoca en la
  // dirección peligrosa (#1674). No se le inventa una tasa de decaimiento.
  nominal_amount:
    "Importe nominal: a fecha futura no son euros de hoy, y contarlo como tales sobreestimaría lo que te llegará, así que no cuenta en las cifras.",
};
