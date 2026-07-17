import { readStoreTarget } from "@web/read-store-target";
import { enqueueSourceSyncOrInline } from "@web/sync-queue";
import { type SourceSyncJobPayload, sourceSyncDescriptor } from "@worthline/db";

/**
 * The shared connect/manual enqueue seam (PRD #999 S4, #1064): resolve the
 * request's store target, build the `source-sync` descriptor, and enqueue it onto
 * the durable queue — or run `runInline` when no control plane makes the queue
 * available (pure single-user local). Every connected-source trigger (Binance /
 * Numista connect + manual) routes through this ONE helper, so a new provider
 * wires the queue once rather than repeating the target-resolution + descriptor
 * plumbing per action. Each caller supplies its own `runInline` because the
 * fallback store handle differs (a connect flow already holds one; a manual action
 * opens its own via `runActionWithStore`).
 */
export async function enqueueSourceSync(
  payload: SourceSyncJobPayload,
  runInline: () => Promise<void>,
): Promise<void> {
  await enqueueSourceSyncOrInline({
    descriptor: sourceSyncDescriptor(payload),
    runInline,
    target: await readStoreTarget(),
  });
}
