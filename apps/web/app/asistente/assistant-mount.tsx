import {
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
} from "@web/demo/write-guard";
import { readStoreTarget } from "@web/read-store-target";

import AssistantLauncher from "./assistant-launcher";

/**
 * Server gate for the assistant layer (#629): only workspaces get a chat —
 * logged-out visitors (login page) see nothing. Demo personas DO get it
 * (bounded by the coarse rate limit, ADR 0051). Mounted in the root layout
 * so the panel survives in-app navigation (S0 decision, #628).
 *
 * Renders the lightweight {@link AssistantLauncher} rather than the layer
 * directly (#1192): the heavy chat engine is `next/dynamic`-imported and only
 * loads when the panel is first opened, keeping it out of every workspace
 * page's initial bundle and hydration.
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
    <AssistantLauncher
      mutationsDisabled={mutationsDisabled}
      mutationsDisabledMessage={
        target.kind === "demo" ? DEMO_DISABLED_MESSAGE : IMPERSONATION_READONLY_MESSAGE
      }
    />
  );
}
