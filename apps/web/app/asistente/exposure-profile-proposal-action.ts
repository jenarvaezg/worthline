"use server";

import { runActionWithStore } from "@web/action-store";
import {
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
} from "@web/demo/write-guard";
import { readStoreTarget } from "@web/read-store-target";
import type { WorthlineStore } from "@web/store";

import {
  agentStampedProfile,
  parseExposureProfileProposalDrafts,
  readEligibleExposureProfileKeys,
} from "./exposure-profile-proposals";

export type ExposureProfileProposalConfirmResult =
  | { status: "applied"; applied: number }
  | { status: "blocked"; message: string }
  | { status: "error"; message: string };

export async function confirmExposureProfileProposalAction(
  rawDrafts: unknown,
  _store?: WorthlineStore,
  _declaredAt = new Date().toISOString(),
): Promise<ExposureProfileProposalConfirmResult> {
  const target = await readStoreTarget();
  if (target.kind === "demo") {
    return { status: "blocked", message: DEMO_DISABLED_MESSAGE };
  }
  if (target.kind === "authenticated" && target.impersonatedEmail !== undefined) {
    return { status: "blocked", message: IMPERSONATION_READONLY_MESSAGE };
  }

  const parsed = parseExposureProfileProposalDrafts(rawDrafts);
  if (!parsed.ok) {
    return { status: "error", message: parsed.error };
  }

  return runActionWithStore(async (store) => {
    const eligibleKeys = await readEligibleExposureProfileKeys(store);
    if (parsed.drafts.some((draft) => !eligibleKeys.has(draft.key))) {
      return {
        status: "error",
        message: "La propuesta no apunta a una posición elegible.",
      };
    }

    for (const draft of parsed.drafts) {
      await store.exposureProfiles.saveExposureProfile(
        agentStampedProfile(draft, _declaredAt),
      );
    }

    return { status: "applied", applied: parsed.drafts.length };
  }, _store);
}
