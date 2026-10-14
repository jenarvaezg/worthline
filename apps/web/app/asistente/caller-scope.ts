import { ownWorkspaceId } from "@web/demo/write-guard";
import type { StoreTarget } from "@web/store-resolver";

/**
 * WHO a shared-resource meter counts (ADR 0051), separated from HOW MUCH each one
 * allows.
 *
 * Every counter over the shared provider key answers the same question first — is
 * this a workspace, a demo visitor, or the developer's own machine? — and then a
 * different one: how many requests an hour (`rate-limit.ts`), how many document
 * readings a day (`vision-call-budget.ts`). The first answer was written twice
 * before #1258; two copies of a scope key are two chances for a counter to be keyed
 * on something subtly different from the counter next to it, which is the one bug
 * a fuse cannot afford.
 *
 * `local` bypasses: the developer controls the environment and owns the key.
 */
export type CallerScope = { mode: "count"; key: string } | { mode: "bypass" };

/**
 * This caller's counter key. Demo and unauthenticated callers key on IP, and an
 * absent IP shares ONE bucket rather than escaping the counter: a missing header
 * must never be the way out.
 *
 * An admin impersonating a workspace keys on IP too (#1845): the counters are still
 * there, but the turn is the admin's, so it must not spend the user's hour or day.
 */
export function callerScope(target: StoreTarget, ip: string | null): CallerScope {
  switch (target.kind) {
    case "local":
      return { mode: "bypass" };
    case "authenticated": {
      const workspaceId = ownWorkspaceId(target);
      return workspaceId === null
        ? { mode: "count", key: `impersonation:${ip ?? "unknown"}` }
        : { mode: "count", key: `ws:${workspaceId}` };
    }
    case "demo":
      return { mode: "count", key: `demo:${ip ?? "unknown"}` };
    case "unauthenticated":
      return { mode: "count", key: `ip:${ip ?? "unknown"}` };
  }
}
