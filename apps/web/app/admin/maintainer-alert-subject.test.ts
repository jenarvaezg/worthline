import { describe, expect, it } from "vitest";

import {
  maintainerAlertScopeLine,
  maintainerAlertSubject,
} from "./maintainer-alert-subject";

describe("maintainerAlertSubject", () => {
  it("names a tenant alert by workspace and holding", () => {
    expect(
      maintainerAlertSubject({
        category: "infidelity",
        holdingId: "wl_hld_loan",
        workspaceId: "ws-ana",
      }),
    ).toEqual({ kind: "holding", subject: "wl_hld_loan", workspace: "ws-ana" });
  });

  it("translates a fleet alert's sentinels into the fleet and the pass (#1339)", () => {
    expect(
      maintainerAlertSubject({
        category: "missed_capture",
        holdingId: "daily-capture:2026-07-28:pm",
        workspaceId: "fleet",
      }),
    ).toEqual({
      kind: "global",
      subject: "28-07-2026, captura de tarde (≈21:00 UTC)",
      workspace: "flota",
    });
  });

  it("names the shared catalog and the identity for a collision (#1744)", () => {
    expect(
      maintainerAlertSubject({
        category: "catalog_identity_collision",
        holdingId: "dgs:N5394",
        workspaceId: "catalog",
      }),
    ).toEqual({ kind: "global", subject: "dgs:N5394", workspace: "catálogo compartido" });
  });

  it("names the sync phase of a workspace, not a holding, for the cron's sync alert (#1755)", () => {
    expect(
      maintainerAlertSubject({
        category: "sync_source",
        holdingId: "source-sync:ws-jose",
        workspaceId: "ws-jose",
      }),
    ).toEqual({
      kind: "workspace",
      subject: "sincronización de fuentes conectadas",
      workspace: "ws-jose",
    });
  });

  it("leaves a sync_source alert about a REAL holding alone", () => {
    // The assistant raises this category over an actual holding (ADR 0064); only
    // the cron's sentinel gets translated.
    expect(
      maintainerAlertSubject({
        category: "sync_source",
        holdingId: "hld-1234",
        workspaceId: "ws-jose",
      }),
    ).toEqual({ kind: "holding", subject: "hld-1234", workspace: "ws-jose" });
  });

  it("names a user's feedback by workspace and message, never its sentinel (#1174)", () => {
    expect(
      maintainerAlertSubject({
        category: "user_feedback",
        holdingId: "feedback:0f8fad5b-d9cb-469f-a165-70867728950e",
        workspaceId: "ws-ana",
      }),
    ).toEqual({ kind: "workspace", subject: "mensaje del usuario", workspace: "ws-ana" });
  });
});

describe("maintainerAlertScopeLine", () => {
  it("says «holding» only when the subject IS a holding", () => {
    expect(
      maintainerAlertScopeLine({
        kind: "holding",
        subject: "wl_hld_loan",
        workspace: "ws-ana",
      }),
    ).toBe("workspace ws-ana · holding wl_hld_loan");
    // Until the subject carried its kind, the cron's sync alert read «holding
    // sincronización de fuentes conectadas» in the detail header.
    expect(
      maintainerAlertScopeLine({
        kind: "workspace",
        subject: "sincronización de fuentes conectadas",
        workspace: "ws-jose",
      }),
    ).toBe("workspace ws-jose · sincronización de fuentes conectadas");
    expect(
      maintainerAlertScopeLine({
        kind: "global",
        subject: "dgs:N5394",
        workspace: "catálogo compartido",
      }),
    ).toBe("catálogo compartido · dgs:N5394");
  });
});
