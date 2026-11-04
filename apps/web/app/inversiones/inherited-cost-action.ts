"use server";

import { type FormActionState, formActionInlineError } from "@web/form-action";
import { errorRedirectUrl, successRedirectUrl } from "@web/intake";
import { parseMoneyMinor } from "@web/intake-primitives";
import type { ResolveInheritedCostRefusal } from "@worthline/db";
import { INHERITED_COST_FORM_ID } from "./inherited-cost-form-id";

/** The fields a refusal hands back, so nobody retypes the cost. */
const REFILL_FIELDS = ["inheritedCost"] as const;

type ParsedAnswer =
  | { kind: "declared"; entryId: string; costMinor: number }
  | { kind: "origin"; entryId: string; originId: string };

/** Each refusal in words, beside the field (interaction-patterns §4.1). */
function refusalMessage(reason: ResolveInheritedCostRefusal): string {
  switch (reason) {
    case "cost_not_positive":
      return "Escribe el coste en euros, por ejemplo 6.200,00.";
    case "not_pending":
      return "Ese coste ya está guardado. Recarga la ficha para verlo.";
    case "not_a_candidate":
    case "origin_has_fees":
      return "Ese reembolso ya no puede ser el origen de esta entrada. Escribe el coste.";
    case "not_found":
      return "Esa entrada ya no está en este holding. Recarga la ficha.";
  }
}

function parseAnswer(formData: FormData): ParsedAnswer | { error: string } {
  const entryId = String(formData.get("entryId") ?? "").trim();
  if (entryId === "") return { error: refusalMessage("not_found") };
  if (formData.get("mode") === "origin") {
    const originId = String(formData.get("originId") ?? "").trim();
    if (originId === "") return { error: refusalMessage("not_a_candidate") };
    return { entryId, kind: "origin", originId };
  }
  const costMinor = parseMoneyMinor(String(formData.get("inheritedCost") ?? ""));
  if (costMinor === null || costMinor <= 0) {
    return { error: refusalMessage("cost_not_positive") };
  }
  return { costMinor, entryId, kind: "declared" };
}

/**
 * «Coste del traspaso» (#1882, PRD #1876 S7): the one write a user makes on a
 * holding its source owns. Either the cost typed from the old provider's papers, or
 * «Sí, vienen de ahí» on the reimbursement the rule proposed.
 *
 * A refusal comes back as state beside the field (#1311); success redirects to the
 * ledger with the notice that says which way it went. The arithmetic and the
 * refusals are the command's — `resolveInheritedCost` — never this action's.
 */
export async function resolveInheritedCostAction(
  assetId: string,
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<FormActionState> {
  const returnUrl = (formData.get("currentUrl") as string) || "/patrimonio";
  const values = Object.fromEntries(
    REFILL_FIELDS.map((field) => [field, String(formData.get(field) ?? "")]),
  );

  return formActionInlineError<ParsedAnswer, ParsedAnswer["kind"]>({
    datedFact: false,
    guardUrl: () => returnUrl,
    onError: ({ error }) => ({ error, values }),
    onErrorUrl: ({ error }) =>
      errorRedirectUrl(returnUrl, {
        formId: INHERITED_COST_FORM_ID,
        message: error,
        values,
      }),
    onSuccess: ({ value }) =>
      successRedirectUrl(
        returnUrl,
        value === "origin" ? "inherited_cost_from_origin" : "inherited_cost_declared",
      ),
    parse: ({ formData: fd }) => {
      const parsed = parseAnswer(fd);
      return "error" in parsed
        ? { error: parsed.error, ok: false, values }
        : { ok: true, value: parsed };
    },
    requireId: false,
    run: async (store, { parsed, today }) => {
      const result = await store.command.resolveInheritedCost(
        parsed.kind === "declared"
          ? {
              assetId,
              costMinor: parsed.costMinor,
              entryOperationId: parsed.entryId,
              kind: "declared",
              today,
            }
          : {
              assetId,
              entryOperationId: parsed.entryId,
              kind: "origin",
              originOperationId: parsed.originId,
              today,
            },
      );
      return result.ok
        ? { ok: true, value: parsed.kind }
        : { error: refusalMessage(result.reason), ok: false };
    },
  })(formData, ..._testArgs);
}
