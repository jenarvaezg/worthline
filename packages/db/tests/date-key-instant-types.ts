import type { InferSelectModel } from "drizzle-orm";

import { assetOperations, snapshots } from "@db/schema";

type OperationRow = InferSelectModel<typeof assetOperations>;
type SnapshotRow = InferSelectModel<typeof snapshots>;

declare const operation: OperationRow;
declare const snapshot: SnapshotRow;

// @ts-expect-error Date-key columns must not accept ISO instants silently.
const operationDateKey: OperationRow["executedAt"] = snapshot.capturedAt;

// @ts-expect-error Date-key and instant comparisons must be explicit conversions.
const mixedComparison = operation.executedAt === snapshot.capturedAt;

void mixedComparison;
void operationDateKey;
