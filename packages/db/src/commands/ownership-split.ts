import type { UpdateAssetInput } from "@db/asset-store";
import type { UpdateLiabilityInput } from "@db/liability-store";
import type { WorthlineStore } from "@db/store-types";
import { checkOwnershipSplit, type DomainViolation } from "@worthline/domain";

// ── Command inputs ────────────────────────────────────────────────────────────

export interface UpdateAssetOwnershipSplitCommand {
  assetId: string;
  patch: UpdateAssetInput;
  /** Real-estate holdings accept a known partial split (e.g. 75% mine). */
  allowKnownPartial?: boolean;
  today?: string;
}

export interface UpdateLiabilityOwnershipSplitCommand {
  liabilityId: string;
  patch: UpdateLiabilityInput;
  /** Debts on a co-owned home mirror the asset's partial split. */
  allowKnownPartial?: boolean;
  today?: string;
}

export type OwnershipSplitViolation = Extract<
  DomainViolation,
  { code: "ownership_split_invalid" }
>;

export type OwnershipSplitCommandResult =
  | { ok: true; value: void }
  | { ok: false; violation: OwnershipSplitViolation }
  | { ok: false; error: string };

// ── Executors ───────────────────────────────────────────────────────────────

function defaultToday(today?: string): string {
  return today ?? new Date().toISOString().slice(0, 10);
}

async function validateOwnershipInPatch(
  store: WorthlineStore,
  patch: { ownership?: UpdateAssetInput["ownership"] },
  allowKnownPartial: boolean,
): Promise<OwnershipSplitCommandResult | null> {
  if (!patch.ownership) {
    return null;
  }

  const workspace = await store.workspace.readWorkspace();
  if (!workspace) {
    return { ok: false, error: "Workspace no inicializado." };
  }

  const violation = checkOwnershipSplit(workspace, patch.ownership, {
    allowKnownPartial,
  });
  if (violation) {
    return { ok: false, violation };
  }

  return null;
}

export async function executeUpdateAssetOwnershipSplitCommand(
  store: WorthlineStore,
  command: UpdateAssetOwnershipSplitCommand,
): Promise<OwnershipSplitCommandResult> {
  const validation = await validateOwnershipInPatch(
    store,
    command.patch,
    command.allowKnownPartial ?? false,
  );
  if (validation) {
    return validation;
  }

  const today = defaultToday(command.today);
  await store.command.updateAssetOwnership(command.assetId, command.patch, { today });
  return { ok: true, value: undefined };
}

export async function executeUpdateLiabilityOwnershipSplitCommand(
  store: WorthlineStore,
  command: UpdateLiabilityOwnershipSplitCommand,
): Promise<OwnershipSplitCommandResult> {
  const validation = await validateOwnershipInPatch(
    store,
    command.patch,
    command.allowKnownPartial ?? false,
  );
  if (validation) {
    return validation;
  }

  await store.command.updateLiabilityOwnership(command.liabilityId, command.patch);
  return { ok: true, value: undefined };
}
