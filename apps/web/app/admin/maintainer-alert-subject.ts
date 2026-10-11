import type { MaintainerAlertCategory } from "@worthline/db";

import {
  dailyCapturePassLabel,
  missedCapturePassFromHoldingId,
} from "./missed-capture-alert";
import { sourceSyncWorkspaceFromHoldingId } from "./source-sync-alert";

/**
 * What a maintainer alert is ABOUT, in words a maintainer reads (ADR 0064).
 *
 * The holding slot of the dedup key does not always hold a holding: four raisers
 * put a sentinel there to name the alert's subject, and those must never reach a
 * maintainer's eyes raw. The `kind` says which shape the subject has, so the two
 * surfaces that print it — the `/admin` index (two cells) and the detail header
 * (one line) — read one answer instead of re-branching on flags:
 *
 *   - `holding`: a tenant's real holding (the assistant's alerts);
 *   - `workspace`: about a workspace, not one of its holdings — the cron's sync
 *     phase (#1755), a user's feedback message (#1174);
 *   - `global`: about no tenant at all — a missed cron pass (#1339), a catalog
 *     identity collision (#1744).
 */
export interface MaintainerAlertSubject {
  kind: "holding" | "workspace" | "global";
  /** The ámbito: a workspace id, or the global scope in words. */
  workspace: string;
  /** The sujeto: the holding id, or the sentinel translated into words. */
  subject: string;
}

export function maintainerAlertSubject(alert: {
  category: MaintainerAlertCategory;
  workspaceId: string;
  holdingId: string;
}): MaintainerAlertSubject {
  switch (alert.category) {
    case "user_feedback":
      // Who wrote is half the answer, so the workspace stays named.
      return {
        kind: "workspace",
        subject: "mensaje del usuario",
        workspace: alert.workspaceId,
      };
    case "catalog_identity_collision":
      return {
        kind: "global",
        subject: alert.holdingId,
        workspace: "catálogo compartido",
      };
    case "missed_capture": {
      const pass = missedCapturePassFromHoldingId(alert.holdingId);
      if (pass !== null) {
        return {
          kind: "global",
          subject: dailyCapturePassLabel(pass),
          workspace: "flota",
        };
      }
      break;
    }
    case "sync_source":
      // The cron's alert names the workspace's sync phase, which it isolates per
      // workspace and not per holding. The assistant raises the same category over
      // a real holding, which falls through untouched.
      if (sourceSyncWorkspaceFromHoldingId(alert.holdingId) !== null) {
        return {
          kind: "workspace",
          subject: "sincronización de fuentes conectadas",
          workspace: alert.workspaceId,
        };
      }
      break;
    case "infidelity":
    case "residual":
      break;
  }
  return { kind: "holding", subject: alert.holdingId, workspace: alert.workspaceId };
}

/** The detail header's «ámbito · sujeto» line — «holding» only when it is one. */
export function maintainerAlertScopeLine(subject: MaintainerAlertSubject): string {
  switch (subject.kind) {
    case "holding":
      return `workspace ${subject.workspace} · holding ${subject.subject}`;
    case "workspace":
      return `workspace ${subject.workspace} · ${subject.subject}`;
    case "global":
      return `${subject.workspace} · ${subject.subject}`;
  }
}
