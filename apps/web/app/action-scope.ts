import type { WorthlineStore } from "@web/store";
import { listScopeOptions } from "@worthline/domain";

export const INVALID_SCOPE_MESSAGE = "No se encontró el scope seleccionado.";

export async function actionScopeExists(
  store: WorthlineStore,
  scopeId: string,
): Promise<boolean> {
  const workspace = await store.workspace.readWorkspace();

  return workspace
    ? listScopeOptions(workspace).some((scope) => scope.id === scopeId)
    : false;
}
