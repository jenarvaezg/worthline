"use server";

import { actionScopeExists, INVALID_SCOPE_MESSAGE } from "@web/action-scope";
import { currentUrlOf } from "@web/ajustes/connected-source-helpers";
import { formAction } from "@web/form-action";
import {
  managedPortfolioFichaHref,
  managedPortfolioPublicIdIndex,
  managedPortfoliosIndexHref,
} from "@web/holding-route";
import { appendParam, errorRedirectUrl, preserveFields } from "@web/intake";
import { resolveOwnershipSplit } from "@web/intake-primitives";
import type { OwnershipShare, Workspace } from "@worthline/domain";
import { assertManagedPortfolioInput } from "@worthline/domain";

/**
 * Managed-portfolio intake (ADR 0085, #1547).
 *
 * This layer only parses what was typed and lets the DOMAIN and the STORE say
 * whether it is valid (`assertManagedPortfolioInput` here; eligibility,
 * exclusivity and the auto-created cash sibling at the store door). The alta
 * lands on the new portfolio's ficha — assigning members is the very next step
 * of the flow, and the ficha is where its composition becomes readable.
 */

type ParsedPortfolioForm = {
  name: string;
  provider: string | null;
  holdingIds: string[];
};

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

/** Form fields worth refilling after a validation error (members included). */
function preservePortfolioFields(formData: FormData): Record<string, string> {
  return {
    ...preserveFields(formData, ["name", "provider"]),
    holdingIds: formData.getAll("holdingIds").map(String).join(","),
  };
}

function parsePortfolioForm(
  formData: FormData,
): { ok: true; value: ParsedPortfolioForm } | { ok: false; error: string } {
  const name = field(formData, "name");
  const provider = field(formData, "provider") || null;
  const holdingIds = formData
    .getAll("holdingIds")
    .map((value) => String(value).trim())
    .filter(Boolean);

  try {
    assertManagedPortfolioInput({ name });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, value: { holdingIds, name, provider } };
}

/** One error terminal per form: bounce back beside the form that produced it. */
function portfolioErrorRedirect(
  formData: FormData,
  input: { anchor?: string; formId: string; message: string },
): string {
  return errorRedirectUrl(currentUrlOf(formData), {
    ...(input.anchor ? { anchor: input.anchor } : {}),
    formId: input.formId,
    message: input.message,
    values: preservePortfolioFields(formData),
  });
}

/**
 * The auto-created cash sibling's ownership, resolved with the SAME primitive
 * every other alta uses (`resolveOwnershipSplit`): a member scope's owner keeps
 * the whole split; the household splits evenly across its members.
 */
function cashOwnershipFor(workspace: Workspace, scopeId: string): OwnershipShare[] {
  return resolveOwnershipSplit({
    activeMembers: workspace.members,
    shortfall: "complete-to-full-ownership",
    ...(scopeId === "household"
      ? { preset: "even" as const }
      : { preset: "scope" as const, scopeMemberId: scopeId }),
  });
}

export async function createManagedPortfolioAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<
    ParsedPortfolioForm & { scopeId: string },
    { publicId: string | null }
  >({
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    onError: ({ formData, error }) =>
      portfolioErrorRedirect(formData, {
        anchor: "carterasCreateForm",
        formId: "cartera",
        message: error,
      }),
    onSuccess: ({ formData, value }) =>
      value?.publicId
        ? appendParam(managedPortfolioFichaHref(value.publicId), "ok", "cartera_creada")
        : appendParam(currentUrlOf(formData), "ok", "cartera_creada"),
    parse: ({ formData }) => {
      const scopeId = field(formData, "scopeId");
      if (!scopeId) {
        return {
          ok: false,
          redirect: portfolioErrorRedirect(formData, {
            anchor: "carterasCreateForm",
            formId: "cartera",
            message: "Falta el ámbito de la cartera.",
          }),
        };
      }
      const parsed = parsePortfolioForm(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: portfolioErrorRedirect(formData, {
            anchor: "carterasCreateForm",
            formId: "cartera",
            message: parsed.error,
          }),
        };
      }
      return { ok: true, value: { ...parsed.value, scopeId } };
    },
    requireId: false,
    run: async (store, { parsed }) => {
      if (!(await actionScopeExists(store, parsed.scopeId))) {
        return { ok: false, error: INVALID_SCOPE_MESSAGE };
      }
      const workspace = await store.workspace.readWorkspace();
      if (!workspace) {
        return { ok: false, error: "El workspace aún no está inicializado." };
      }

      const created = await store.managedPortfolios.createManagedPortfolio({
        cashOwnership: cashOwnershipFor(workspace, parsed.scopeId),
        memberHoldingIds: parsed.holdingIds,
        name: parsed.name,
        provider: parsed.provider,
        scopeId: parsed.scopeId,
      });

      // The alta lands on the ficha; a missing registry row would blank the
      // redirect, so degrade to staying on the list instead of throwing.
      const index = managedPortfolioPublicIdIndex(await store.agentView.readPublicIds());
      return {
        ok: true,
        value: { publicId: index.publicByInternal.get(created.id) ?? null },
      };
    },
  })(formData, ..._testArgs);
}

export async function updateManagedPortfolioAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ id: string; form: ParsedPortfolioForm }>({
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    onError: ({ formData, error }) => {
      const id = field(formData, "portfolioId");
      return portfolioErrorRedirect(formData, {
        anchor: `portfolioEdit-${id}`,
        formId: `cartera-${id}`,
        message: error,
      });
    },
    onSuccess: ({ formData }) =>
      appendParam(currentUrlOf(formData), "ok", "cartera_guardada"),
    parse: ({ formData }) => {
      const id = field(formData, "portfolioId");
      if (!id) {
        return {
          ok: false,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            formId: "cartera",
            message: "Identificador de cartera no encontrado.",
          }),
        };
      }
      const parsed = parsePortfolioForm(formData);
      if (!parsed.ok) {
        return {
          ok: false,
          redirect: portfolioErrorRedirect(formData, {
            anchor: `portfolioEdit-${id}`,
            formId: `cartera-${id}`,
            message: parsed.error,
          }),
        };
      }
      return { ok: true, value: { form: parsed.value, id } };
    },
    requireId: false,
    run: async (store, { parsed }) => {
      await store.managedPortfolios.updateManagedPortfolio(parsed.id, {
        // Always sent: the form paints every eligible holding as a chip, so an
        // absent chip means "quit", never "leave the set as it was". The
        // auto-created cash sibling is not a chip and survives regardless.
        memberHoldingIds: parsed.form.holdingIds,
        name: parsed.form.name,
        provider: parsed.form.provider,
      });
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

export async function deleteManagedPortfolioAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction({
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    onError: ({ formData, error }) =>
      errorRedirectUrl(currentUrlOf(formData), { message: error }),
    onSuccess: () => appendParam(managedPortfoliosIndexHref(), "ok", "cartera_borrada"),
    parse: ({ formData }) => {
      const id = field(formData, "portfolioId");
      if (!id) {
        return {
          ok: false,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            message: "Identificador de cartera no encontrado.",
          }),
        };
      }
      return { ok: true, value: id };
    },
    requireId: false,
    run: async (store, { parsed }) => {
      // Dissolving the group leaves every holding alive — members included.
      await store.managedPortfolios.deleteManagedPortfolio(parsed);
      return { ok: true };
    },
  })(formData, ..._testArgs);
}
