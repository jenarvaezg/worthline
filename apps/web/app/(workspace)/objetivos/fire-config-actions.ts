"use server";

import { actionScopeExists, INVALID_SCOPE_MESSAGE } from "@web/action-scope";
import { formAction } from "@web/form-action";
import {
  appendParam,
  errorRedirectUrl,
  localRedirectPath,
  parseFireConfigFormStrict,
} from "@web/intake";
import type { FireRetirementPlan } from "@worthline/domain";

/**
 * Where a save lands when the form's `currentUrl` is missing or not local. It is
 * /objetivos, never /ajustes: the fallback of the action that moved cannot send the
 * user back to the screen the form moved OUT of (#1450).
 */
const currentUrlOf = (formData: FormData): string =>
  localRedirectPath(String(formData.get("currentUrl") ?? ""), "/objetivos");

/**
 * Saving the FIRE assumptions, from the screen that shows them (#1450).
 *
 * The action moved here with its form: /ajustes no longer owns the FIRE config, so
 * the write and the surface that offers it live together. The redirect follows
 * `currentUrl`, which is now /objetivos — the user lands back on the figures the
 * save just moved, not on a settings page they had to leave to see the effect.
 */
export const saveFireConfigAction = formAction({
  requireId: false,
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  parse: ({ formData }) => {
    const scopeId = String(formData.get("scopeId") ?? "").trim() || "household";
    const result = parseFireConfigFormStrict(formData);
    if (!result.ok) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          message: result.error,
          formId: "fire",
        }),
      };
    }
    return { ok: true, value: { scopeId, command: result.command } };
  },
  run: async (store, { parsed }) => {
    if (!(await actionScopeExists(store, parsed.scopeId))) {
      return { ok: false, error: INVALID_SCOPE_MESSAGE };
    }
    await store.saveFireConfig(parsed.scopeId, parsed.command);
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error, formId: "fire" }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "fire_saved"),
});

/**
 * Declarar (o desdeclarar) que el plan es una jubilación ordinaria (#1428, ADR 0081).
 *
 * Es el atajo del ofrecimiento: la pantalla detecta las señales, ofrece —«parece que
 * tu plan es jubilación ordinaria, ¿quieres verlo así?»— y este botón escribe la
 * respuesta. Las dos direcciones pasan por aquí, porque un «no» también hay que
 * guardarlo: sin persistirlo, el ofrecimiento volvería en cada carga y la app estaría
 * insistiéndole al usuario en que no va a hacer FIRE.
 *
 * Escribe UN campo sobre la config guardada, no el formulario entero: el ofrecimiento
 * vive en el panel de resultados, lejos de los supuestos, y mandar los demás campos
 * desde ahí significaría tener una segunda copia de ellos en pantalla. De ahí la
 * lectura previa — y de ahí que `currentAge` se quite antes de escribir: `readFireConfig`
 * la DERIVA de la fecha de nacimiento (#1415), así que reescribirla tal cual congelaría
 * en almacenamiento una edad que el lector recalcula cada año. `saveFireConfig` ya
 * devuelve la edad heredada de una config antigua cuando el comando no la trae, que es
 * exactamente el comportamiento que hace falta aquí.
 */
export const setRetirementPlanAction = formAction({
  requireId: false,
  datedFact: false,
  guardUrl: (fd) => currentUrlOf(fd),
  parse: ({ formData }) => {
    const scopeId = String(formData.get("scopeId") ?? "").trim() || "household";
    const declared = String(formData.get("retirementPlan") ?? "").trim();
    const plan: FireRetirementPlan | null =
      declared === "ordinary" ? "ordinary" : declared === "early" ? "early" : null;
    if (plan === null) {
      return {
        ok: false,
        redirect: errorRedirectUrl(currentUrlOf(formData), {
          message: "No hemos entendido qué plan quieres ver.",
          formId: "fire",
        }),
      };
    }
    return { ok: true, value: { plan, scopeId } };
  },
  run: async (store, { parsed, today }) => {
    if (!(await actionScopeExists(store, parsed.scopeId))) {
      return { ok: false, error: INVALID_SCOPE_MESSAGE };
    }
    const stored = (await store.readFireConfig(today))[parsed.scopeId];
    if (stored === undefined) {
      // Sin supuestos guardados no hay pantalla que trocar: el ofrecimiento no se
      // pinta, así que llegar aquí es un formulario fuera de sitio.
      return { ok: false, error: "Configura tus supuestos FIRE antes de elegir vista." };
    }
    const { currentAge: _derivedAge, ...config } = stored;
    await store.saveFireConfig(parsed.scopeId, {
      ...config,
      retirementPlan: parsed.plan,
    });
    return { ok: true };
  },
  onError: ({ formData, error }) =>
    errorRedirectUrl(currentUrlOf(formData), { message: error, formId: "fire" }),
  onSuccess: ({ formData }) => appendParam(currentUrlOf(formData), "ok", "fire_saved"),
});
