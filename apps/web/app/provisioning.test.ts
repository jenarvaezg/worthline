import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryControlPlaneStore, type TursoPort } from "@worthline/db";
import { afterAll, describe, expect, test, vi } from "vitest";

import {
  admitSignIn,
  resolveWorkspaceForSignIn,
  workspaceForSessionToken,
} from "./provisioning";
import {
  DAILY_PROVISIONING_CAP_ENV,
  PROVISIONING_CLOSED_LOGIN_PATH,
} from "./provisioning-cap";
import { withSignInHandoff } from "./sign-in-handoff";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

/** A Turso port that "creates" local file databases — no network. */
function fakeTurso(): { port: TursoPort; created: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "worthline-web-provisioning-"));
  tempDirs.push(dir);
  const created: string[] = [];
  return {
    created,
    port: {
      async createDatabase(name) {
        created.push(name);
        return { name, url: `file:${join(dir, `${name}.sqlite`)}` };
      },
      async createDatabaseToken(name) {
        return { jwt: `token-for-${name}` };
      },
    },
  };
}

const MORNING = "2026-03-14T09:00:00.000Z";
const skipMigration = async () => {};
const PRODUCTION = { VERCEL_ENV: "production" };

// Illustrative limits only — the real figure lives in the deployment's env.
async function harness(env: Record<string, string> = {}) {
  const controlPlane = await createInMemoryControlPlaneStore();
  const turso = fakeTurso();
  const deps = {
    controlPlane,
    now: () => MORNING,
    openAndMigrate: skipMigration,
    turso: turso.port,
  };
  return { controlPlane, created: turso.created, deps, env };
}

const capOf = (value: string) => ({ [DAILY_PROVISIONING_CAP_ENV]: value });

describe("resolveWorkspaceForSignIn · daily provisioning cap (#1175)", () => {
  test("a new identity past the cap is refused and the maintainer hears about it", async () => {
    const { controlPlane, created, deps, env } = await harness(capOf("1"));
    try {
      const ana = await resolveWorkspaceForSignIn("ana@example.com", env, deps);
      expect(ana.kind).toBe("ready");

      expect(await resolveWorkspaceForSignIn("leo@example.com", env, deps)).toEqual({
        kind: "closed",
      });
      expect(await resolveWorkspaceForSignIn("eva@example.com", env, deps)).toEqual({
        kind: "closed",
      });
      expect(created).toHaveLength(1);

      // One alert for the day, one occurrence per refused sign-up (ADR 0064).
      const alerts = await controlPlane.listMaintainerAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        category: "provisioning_cap",
        holdingId: "provisioning-cap:2026-03-14",
        occurrenceCount: 2,
        workspaceId: "fleet",
      });
      const detail = await controlPlane.getMaintainerAlert(alerts[0]!.id);
      expect(detail?.occurrences[0]?.payload).toMatchObject({
        cause: "cap_reached",
        limit: 1,
        provisionedToday: 1,
      });
      // Nothing about who was turned away reaches the alert.
      expect(JSON.stringify(detail)).not.toContain("leo@example.com");
      expect(JSON.stringify(detail)).not.toContain("eva@example.com");
    } finally {
      controlPlane.close();
    }
  });

  test("an existing user gets in whatever the cap says — full, closed, misconfigured or unset", async () => {
    const open = await harness();
    try {
      const first = await resolveWorkspaceForSignIn(
        "ana@example.com",
        open.env,
        open.deps,
      );
      if (first.kind !== "ready") throw new Error("expected a provisioned workspace");

      for (const env of [capOf("0"), capOf("cinco"), PRODUCTION]) {
        const again = await resolveWorkspaceForSignIn("ana@example.com", env, open.deps);
        expect(again).toEqual({ kind: "ready", workspace: first.workspace });
      }
      // A returning sign-in is not a refusal: no alert was raised.
      expect(await open.controlPlane.listMaintainerAlerts()).toHaveLength(0);
    } finally {
      open.controlPlane.close();
    }
  });

  test("a misconfigured cap fails closed for new identities and the alert says why", async () => {
    const { controlPlane, created, deps, env } = await harness(capOf("cinco"));
    try {
      expect(await resolveWorkspaceForSignIn("leo@example.com", env, deps)).toEqual({
        kind: "closed",
      });
      expect(created).toHaveLength(0);

      const [alert] = await controlPlane.listMaintainerAlerts();
      const detail = await controlPlane.getMaintainerAlert(alert!.id);
      expect(detail?.occurrences[0]?.payload).toMatchObject({
        cause: "misconfigured",
        configuredValue: "cinco",
      });
    } finally {
      controlPlane.close();
    }
  });

  test("in production, a forgotten variable closes new sign-ups like a typo, and the alert says so", async () => {
    const { controlPlane, created, deps, env } = await harness(PRODUCTION);
    try {
      expect(await resolveWorkspaceForSignIn("leo@example.com", env, deps)).toEqual({
        kind: "closed",
      });
      expect(created).toHaveLength(0);

      const [alert] = await controlPlane.listMaintainerAlerts();
      const detail = await controlPlane.getMaintainerAlert(alert!.id);
      expect(detail?.occurrences[0]?.payload).toMatchObject({
        cause: "unset_in_production",
        limit: 0,
      });
    } finally {
      controlPlane.close();
    }
  });

  test("outside production, without the variable registration stays open (#733)", async () => {
    const { controlPlane, created, deps, env } = await harness({ VERCEL_ENV: "preview" });
    try {
      for (const name of ["a", "b", "c"]) {
        const outcome = await resolveWorkspaceForSignIn(`${name}@example.com`, env, deps);
        expect(outcome.kind).toBe("ready");
      }
      expect(created).toHaveLength(3);
      expect(await controlPlane.listMaintainerAlerts()).toHaveLength(0);
    } finally {
      controlPlane.close();
    }
  });

  test("a failing alert never changes the refusal the person sees", async () => {
    const { controlPlane, deps, env } = await harness(capOf("0"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failingAlerts = {
        ...controlPlane,
        raiseMaintainerAlert: async () => {
          throw new Error("control plane hiccup");
        },
      };
      expect(
        await resolveWorkspaceForSignIn("leo@example.com", env, {
          ...deps,
          controlPlane: failingAlerts,
        }),
      ).toEqual({ kind: "closed" });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      controlPlane.close();
    }
  });
});

describe("admitSignIn (#1175)", () => {
  test("lets a provisioned identity through", async () => {
    const { controlPlane, deps, env } = await harness(capOf("1"));
    try {
      expect(await admitSignIn("ana@example.com", env, deps)).toBe(true);
    } finally {
      controlPlane.close();
    }
  });

  test("sends a refused identity to the honest «hoy estamos llenos» page", async () => {
    const { controlPlane, deps, env } = await harness(capOf("0"));
    try {
      expect(await admitSignIn("leo@example.com", env, deps)).toBe(
        PROVISIONING_CLOSED_LOGIN_PATH,
      );
    } finally {
      controlPlane.close();
    }
  });
});

describe("workspaceForSessionToken · one control-plane open per login (#1175)", () => {
  test("takes the workspace signIn resolved in the same request, without touching the control plane", async () => {
    const { controlPlane, deps, env } = await harness(capOf("1"));
    try {
      const unreachable = new Proxy(controlPlane, {
        get() {
          throw new Error("the jwt callback must not reopen the control plane");
        },
      });
      await withSignInHandoff(async () => {
        expect(await admitSignIn("ana@example.com", env, deps)).toBe(true);
        const workspace = await workspaceForSessionToken("ana@example.com", env, {
          ...deps,
          controlPlane: unreachable,
        });
        expect(workspace.dbUrl).toContain("wl-");
      });
    } finally {
      controlPlane.close();
    }
  });

  test("without a handoff it resolves the workspace itself — an existing user on a closed day included", async () => {
    const { controlPlane, deps } = await harness();
    try {
      const provisioned = await admitSignIn("ana@example.com", {}, deps);
      expect(provisioned).toBe(true);

      const workspace = await workspaceForSessionToken(
        "ana@example.com",
        PRODUCTION,
        deps,
      );
      expect(workspace.id).toBeTruthy();
    } finally {
      controlPlane.close();
    }
  });
});
