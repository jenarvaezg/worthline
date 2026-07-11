import {
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
} from "@web/demo/write-guard";
import { readStoreTarget } from "@web/read-store-target";

import AssistantLayer from "./assistant-layer";

/**
 * Server gate for the assistant layer (#629): only workspaces get a chat —
 * logged-out visitors (login page) see nothing. Demo personas DO get it
 * (bounded by the coarse rate limit, ADR 0051). Mounted in the root layout
 * so the panel survives in-app navigation (S0 decision, #628).
 */
export default async function AssistantMount() {
  const target = await readStoreTarget();
  if (target.kind === "unauthenticated") {
    return null;
  }

  const mutationsDisabled =
    target.kind === "demo" ||
    (target.kind === "authenticated" && target.impersonatedEmail !== undefined);

  return (
    <AssistantLayer
      mutationsDisabled={mutationsDisabled}
      mutationsDisabledMessage={
        target.kind === "demo" ? DEMO_DISABLED_MESSAGE : IMPERSONATION_READONLY_MESSAGE
      }
    />
  );
}
