"use server";

import { formAction } from "@web/form-action";
import {
  errorRedirectUrl,
  parseBalanceAnchorStrict,
  preserveFields,
  successRedirectUrl,
} from "@web/intake";
import { editUrl, requireDebtModel } from "./action-helpers";

/**
 * Balance-anchor actions (revolving/informal debt, ADR 0020 / 0025) — the #1112
 * S1 pilot, migrated to the `formAction` combinator: the shell (test seams, demo
 * guard, id parse, clock, store cycle, redirects) rides the combinator, and the
 * duplicate-date invariant (`runDatedFactAction`, #692) covers these three too —
 * a same-(liability, date) re-submit surfaces a friendly error instead of a raw
 * 500 from the UNIQUE index, exactly like every other dated fact.
 */
export async function addBalanceAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    missingId: "Identificador de deuda no encontrado.",
    parse: ({ formData, id, today }) => {
      const parsed = parseBalanceAnchorStrict(formData, id, Date.now(), today);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(editUrl(id), {
            formId: "balanceAnchor",
            message: parsed.error,
            values: preserveFields(formData, ["anchorDate", "balance"]),
          }),
        };
      }
      return { ok: true, value: parsed.command };
    },
    run: async (store, { id, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "anchorable");
      if (!guard.ok) {
        return guard;
      }
      // Persist + ripple ride the debt seam (ADR 0020), atomically; the from-date
      // is the anchor's own date.
      await store.command.addBalanceAnchor(parsed, { today });
      return { ok: true as const };
    },
    onError: ({ id, error }) =>
      errorRedirectUrl(editUrl(id), { formId: "balanceAnchor", message: error }),
    onSuccess: ({ id }) => successRedirectUrl(editUrl(id), "balance_anchor_added", id),
  })(formData, ..._testArgs);
}

export async function updateBalanceAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    extraIds: ["anchorId"],
    missingId: "Identificador del saldo no encontrado.",
    parse: ({ formData, id, extra, today }) => {
      const parsed = parseBalanceAnchorStrict(formData, id, Date.now(), today);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: errorRedirectUrl(editUrl(id), {
            formId: `balanceAnchor-${extra.anchorId}`,
            message: parsed.error,
            values: preserveFields(formData, ["anchorDate", "balance"]),
          }),
        };
      }
      return { ok: true, value: parsed.command };
    },
    run: async (store, { id, extra, today, parsed }) => {
      const guard = await requireDebtModel(store, id, "anchorable");
      if (!guard.ok) {
        return guard;
      }
      // Persist + ripple ride the debt seam (ADR 0020 / 0025): it reads the OLD
      // anchor date behind the seam, ripples from the earlier of the old/new date,
      // and guards the future. The action no longer pre-reads the row.
      const changes = await store.command.updateBalanceAnchor(
        extra.anchorId!,
        {
          anchorDate: parsed.anchorDate,
          balanceMinor: parsed.balanceMinor,
        },
        { today },
      );
      if (changes === 0) {
        return {
          ok: false as const,
          error: "No se encontró el saldo — puede que ya se haya eliminado.",
        };
      }
      return { ok: true as const };
    },
    onError: ({ id, extra, error }) =>
      errorRedirectUrl(editUrl(id), {
        formId: `balanceAnchor-${extra.anchorId}`,
        message: error,
      }),
    onSuccess: ({ id }) => successRedirectUrl(editUrl(id), "balance_anchor_saved", id),
  })(formData, ..._testArgs);
}

export async function deleteBalanceAnchorAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<undefined>({
    extraIds: ["anchorId"],
    missingId: "Identificador del saldo no encontrado.",
    // Delete carries no body — nothing to parse or validate.
    parse: () => ({ ok: true, value: undefined }),
    run: async (store, { id, extra, today }) => {
      const guard = await requireDebtModel(store, id, "anchorable");
      if (!guard.ok) {
        return guard;
      }
      // Delete + ripple ride the debt seam (ADR 0020 / 0025): it reads the removed
      // anchor's date behind the seam, recalculates from it, and guards the future.
      // The action no longer pre-reads the row.
      const changes = await store.command.deleteBalanceAnchor(extra.anchorId!, { today });
      if (changes === 0) {
        return {
          ok: false as const,
          error: "No se encontró el saldo — puede que ya se haya eliminado.",
        };
      }
      return { ok: true as const };
    },
    onError: ({ id, error }) => errorRedirectUrl(editUrl(id), { message: error }),
    onSuccess: ({ id }) => successRedirectUrl(editUrl(id), "balance_anchor_deleted", id),
  })(formData, ..._testArgs);
}
