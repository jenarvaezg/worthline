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
import {
  parseIsoDateField,
  parseMoneyMinor,
  resolveOwnershipSplit,
} from "@web/intake-primitives";
import type { OwnershipShare, Workspace } from "@worthline/domain";
import {
  assertManagedPortfolioInput,
  managedPortfolioMemberRoles,
} from "@worthline/domain";

/**
 * Managed-portfolio intake (ADR 0085, #1547).
 *
 * The declared balance (#1550) is typed here too, and stays a WITNESS: this
 * layer parses the figure and its date, the store keeps them on the entity, and
 * nothing in the engine ever reads them. The careo can only disagree out loud.
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
    ...preserveFields(formData, ["name", "provider", "declaredValue"]),
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
function containerOwnershipFor(workspace: Workspace, scopeId: string): OwnershipShare[] {
  return resolveOwnershipSplit({
    activeMembers: workspace.members,
    shortfall: "complete-to-full-ownership",
    ...(scopeId === "household"
      ? { preset: "even" as const }
      : { preset: "scope" as const, scopeMemberId: scopeId }),
  });
}

/**
 * Register a cartera. Two altas through one door (#1551):
 *
 * - **Enumerating its funds** — the members are chips, nothing is declared, and
 *   the portfolio's value is the sum of holdings that already summed.
 * - **Only a balance** — no composition at all. The store gives the portfolio an
 *   aggregate "(sin detallar)" member worth exactly what was typed, so the gross
 *   patrimonio is right from minute one instead of under-counted until the owner
 *   lists seven funds he may not have to hand. The same figure is ALSO declared
 *   as the reconciliation witness, through the same single door every declaration
 *   goes through (`declareManagedPortfolioBalance`): it is literally the balance
 *   read in the manager's app, and it is what the substitution suggestion
 *   (`declarado − Σ detallado`) is a share of.
 *
 * The declaration is a second write on purpose. Folding the witness into the
 * create would be a second place that validates and audits a declared balance,
 * and if it fails the portfolio simply has no witness yet — nothing is corrupted.
 */
export async function createManagedPortfolioAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<
    ParsedPortfolioForm & {
      scopeId: string;
      /** The declared balance, when the alta was "only a balance". */
      declaredValueMinor: number | null;
      /** The day the balance was read — today, the day it is being typed. */
      today: string;
    },
    { publicId: string | null; declared: boolean }
  >({
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    onError: ({ formData, error }) =>
      portfolioErrorRedirect(formData, {
        anchor: "carterasCreateForm",
        formId: "cartera",
        message: error,
      }),
    onSuccess: ({ formData, value }) => {
      const ok = value?.declared ? "cartera_creada_sin_detallar" : "cartera_creada";
      return value?.publicId
        ? appendParam(managedPortfolioFichaHref(value.publicId), "ok", ok)
        : appendParam(currentUrlOf(formData), "ok", ok);
    },
    parse: ({ formData, today }) => {
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
      // The balance is OPTIONAL: an alta that enumerates its funds declares
      // nothing. Typed but unreadable is a typo, never "no balance" — bouncing
      // beats registering a cartera the owner believes carries his 1.000 €.
      const typedBalance = field(formData, "declaredValue");
      let declaredValueMinor: number | null = null;
      if (typedBalance) {
        const parsedBalance = parseMoneyMinor(typedBalance);
        if (parsedBalance === null || parsedBalance <= 0) {
          return {
            ok: false,
            redirect: portfolioErrorRedirect(formData, {
              anchor: "carterasCreateForm",
              formId: "cartera",
              message:
                "El saldo de la cartera tiene que ser un importe positivo (o déjalo vacío y añade sus fondos después).",
            }),
          };
        }
        declaredValueMinor = parsedBalance;
      }

      return {
        ok: true,
        value: { ...parsed.value, declaredValueMinor, scopeId, today },
      };
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
        containerOwnership: containerOwnershipFor(workspace, parsed.scopeId),
        memberHoldingIds: parsed.holdingIds,
        name: parsed.name,
        provider: parsed.provider,
        scopeId: parsed.scopeId,
        ...(parsed.declaredValueMinor === null
          ? {}
          : { undetailedValueMinor: parsed.declaredValueMinor }),
      });

      if (parsed.declaredValueMinor !== null) {
        await store.managedPortfolios.declareManagedPortfolioBalance(created.id, {
          declaredDate: parsed.today,
          // Declared in the book's own currency: converting one here would invent
          // a rate inside an intake (#1401).
          declaredValue: {
            amountMinor: parsed.declaredValueMinor,
            currency: workspace.baseCurrency,
          },
        });
      }

      // The alta lands on the ficha; a missing registry row would blank the
      // redirect, so degrade to staying on the list instead of throwing.
      const index = managedPortfolioPublicIdIndex(await store.agentView.readPublicIds());
      return {
        ok: true,
        value: {
          declared: parsed.declaredValueMinor !== null,
          publicId: index.publicByInternal.get(created.id) ?? null,
        },
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

/**
 * Declare (or clear) the portfolio's last read balance (#1550).
 *
 * The amount asked for is the one the manager's app SHOWS — the market value of
 * the funds, without the container's cash — so the owner never adds two figures
 * by hand (the correction of 23-08 on #1550). A future date is refused: a balance
 * can only have been read on a day that has happened.
 */
export async function declareManagedPortfolioBalanceAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{
    id: string;
    witness: { declaredValueMinor: number; declaredDate: string } | null;
  }>({
    datedFact: false,
    guardUrl: (fd) => currentUrlOf(fd),
    onError: ({ formData, error }) => {
      const id = field(formData, "portfolioId");
      return errorRedirectUrl(currentUrlOf(formData), {
        anchor: `portfolioWitness-${id}`,
        formId: `testigo-${id}`,
        message: error,
        values: preserveFields(formData, ["declaredValue", "declaredDate"]),
      });
    },
    onSuccess: ({ formData, value: _value }) =>
      appendParam(
        currentUrlOf(formData),
        "ok",
        field(formData, "clear") ? "testigo_borrado" : "testigo_guardado",
      ),
    parse: ({ formData, today }) => {
      const id = field(formData, "portfolioId");
      const bounce = (message: string) => ({
        ok: false as const,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          anchor: `portfolioWitness-${id}`,
          formId: `testigo-${id}`,
          message,
          values: preserveFields(formData, ["declaredValue", "declaredDate"]),
        }),
      });

      if (!id) return bounce("Identificador de cartera no encontrado.");
      // Clearing is its own submit: an empty amount is a typo, not "forget the
      // witness", so the two intents never share one blank field.
      if (field(formData, "clear")) {
        return { ok: true, value: { id, witness: null } };
      }

      const declaredValueMinor = parseMoneyMinor(field(formData, "declaredValue"));
      if (declaredValueMinor === null || declaredValueMinor <= 0) {
        return bounce("Escribe el saldo declarado como un importe positivo.");
      }
      const date = parseIsoDateField(field(formData, "declaredDate"), {
        futureMessage: "La fecha del saldo declarado no puede ser futura.",
        invalidMessage: "Indica la fecha en la que leíste ese saldo (AAAA-MM-DD).",
        rejectFuture: true,
        today,
      });
      if (!date.ok) return bounce(date.error);

      return {
        ok: true,
        value: { id, witness: { declaredDate: date.date, declaredValueMinor } },
      };
    },
    requireId: false,
    run: async (store, { parsed }) => {
      const workspace = await store.workspace.readWorkspace();
      if (!workspace) {
        return { ok: false, error: "El workspace aún no está inicializado." };
      }

      await store.managedPortfolios.declareManagedPortfolioBalance(
        parsed.id,
        parsed.witness === null
          ? null
          : {
              declaredDate: parsed.witness.declaredDate,
              // The witness is declared in the book's own currency: converting a
              // foreign one here would invent a rate inside an intake (#1401).
              declaredValue: {
                amountMinor: parsed.witness.declaredValueMinor,
                currency: workspace.baseCurrency,
              },
            },
      );
      return { ok: true };
    },
  })(formData, ..._testArgs);
}

/**
 * Progressive substitution of the "(sin detallar)" aggregate (#1551).
 *
 * Two gestures, one door: leave the aggregate at what is left to detail, or
 * retire it because nothing is left. Both are the ORDINARY seams — the manual
 * value update every stored holding uses, and the Papelera — so the ripple, the
 * snapshots and the audit trail are the ones every other value change gets.
 *
 * Retiring writes 0 € BEFORE archiving instead of archiving the value away: the
 * board then shows the drop as a value change on a live holding for the instant
 * it lasts, and the archived row carries no money out of the patrimonio. An
 * aggregate typed down to 0 € is the same gesture said differently, so it takes
 * the same path — a stored holding sitting at 0 € inside a live cartera is a
 * zombie nobody asked for.
 *
 * The aggregate is resolved from the DATABASE (`managedPortfolioMemberRoles`),
 * never from a holding id in the form: the id the client sends is exactly the
 * thing an attacker would change, and the roles rule already lives in one place.
 */
export async function setUndetailedRemainderAction(
  formData: FormData,
  ..._testArgs: unknown[]
): Promise<never> {
  return formAction<{ id: string; remainderMinor: number | null }, { withdrew: boolean }>(
    {
      datedFact: false,
      guardUrl: (fd) => currentUrlOf(fd),
      onError: ({ formData, error }) => {
        const id = field(formData, "portfolioId");
        return errorRedirectUrl(currentUrlOf(formData), {
          anchor: `portfolioUndetailed-${id}`,
          formId: `agregado-${id}`,
          message: error,
          values: preserveFields(formData, ["remainderValue"]),
        });
      },
      onSuccess: ({ formData, value }) =>
        appendParam(
          currentUrlOf(formData),
          "ok",
          value?.withdrew ? "agregado_retirado" : "agregado_ajustado",
        ),
      parse: ({ formData }) => {
        const id = field(formData, "portfolioId");
        const bounce = (message: string) => ({
          ok: false as const,
          redirect: errorRedirectUrl(currentUrlOf(formData), {
            anchor: `portfolioUndetailed-${id}`,
            formId: `agregado-${id}`,
            message,
            values: preserveFields(formData, ["remainderValue"]),
          }),
        });

        if (!id) return bounce("Identificador de cartera no encontrado.");
        // Retiring is its own submit: an empty amount is a typo, not "retire it".
        if (field(formData, "withdraw")) {
          return { ok: true, value: { id, remainderMinor: null } };
        }

        const remainderMinor = parseMoneyMinor(field(formData, "remainderValue"));
        if (remainderMinor === null || remainderMinor < 0) {
          return bounce(
            "Escribe lo que queda sin detallar como un importe (0 retira el agregado).",
          );
        }
        return { ok: true, value: { id, remainderMinor } };
      },
      requireId: false,
      run: async (store, { now, parsed }) => {
        const portfolios = await store.managedPortfolios.readManagedPortfolios();
        const portfolio = portfolios.find((candidate) => candidate.id === parsed.id);
        if (!portfolio) {
          return { ok: false, error: "Esa cartera gestionada ya no existe." };
        }

        const assets = await store.assets.readAssets();
        const roles = managedPortfolioMemberRoles(
          portfolio.holdingIds,
          new Map(assets.map((asset) => [asset.id, asset.type])),
        );
        const holdingId = roles.undetailedHoldingId;
        if (holdingId === null) {
          return {
            ok: false,
            error: "Esta cartera ya no tiene una parte sin detallar que ajustar.",
          };
        }

        const withdraw = parsed.remainderMinor === null || parsed.remainderMinor === 0;
        await store.assets.updateAssetValuation(
          holdingId,
          withdraw ? 0 : parsed.remainderMinor!,
        );

        if (withdraw) {
          const outcome = await store.assets.softDeleteAsset(holdingId, now);
          if (outcome.status !== "deleted") {
            return {
              ok: false,
              error:
                "El agregado se quedó a 0 € pero no se pudo archivar. Vuelve a intentarlo desde su ficha.",
            };
          }
        }

        return { ok: true, value: { withdrew: withdraw } };
      },
    },
  )(formData, ..._testArgs);
}
