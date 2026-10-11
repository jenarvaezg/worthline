import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryControlPlaneStore, type TursoPort } from "@worthline/db";
import { afterAll, describe, expect, test, vi } from "vitest";

import { admitSignIn, resolveWorkspaceForSignIn } from "./provisioning";
import {
  DAILY_PROVISIONING_CAP_ENV,
  PROVISIONING_CLOSED_LOGIN_PATH,
} from "./provisioning-cap";

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

// Illustrative caps only — the real figure lives in the deployment's env.
async function harness(capValue?: string) {
  const controlPlane = await createInMemoryControlPlaneStore();
  const turso = fakeTurso();
  const env = capValue === undefined ? {} : { [DAILY_PROVISIONING_CAP_ENV]: capValue };
  const deps = {
    controlPlane,
    now: () => MORNING,
    openAndMigrate: skipMigration,
    turso: turso.port,
  };
  return { controlPlane, created: turso.created, deps, env };
}

describe("resolveWorkspaceForSignIn · daily provisioning cap (#1175)", () => {
  test("a new identity past the cap is refused and the maintainer hears about it", async () => {
    const { controlPlane, created, deps, env } = await harness("1");
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
        dailyCap: 1,
        reason: "cap_reached",
        used: 1,
      });
      // Nothing about who was turned away reaches the alert.
      expect(JSON.stringify(detail)).not.toContain("leo@example.com");
      expect(JSON.stringify(detail)).not.toContain("eva@example.com");
    } finally {
      controlPlane.close();
    }
  });

  test("an existing user gets in whatever the cap says — full, closed or misconfigured", async () => {
    const open = await harness();
    try {
      const first = await resolveWorkspaceForSignIn(
        "ana@example.com",
        open.env,
        open.deps,
      );
      if (first.kind !== "ready") throw new Error("expected a provisioned workspace");

      for (const capValue of ["0", "cinco"]) {
        const env = { [DAILY_PROVISIONING_CAP_ENV]: capValue };
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
    const { controlPlane, created, deps, env } = await harness("cinco");
    try {
      expect(await resolveWorkspaceForSignIn("leo@example.com", env, deps)).toEqual({
        kind: "closed",
      });
      expect(created).toHaveLength(0);

      const [alert] = await controlPlane.listMaintainerAlerts();
      const detail = await controlPlane.getMaintainerAlert(alert!.id);
      expect(detail?.occurrences[0]?.payload).toMatchObject({
        configuredValue: "cinco",
        reason: "misconfigured",
      });
    } finally {
      controlPlane.close();
    }
  });

  test("without the env var registration stays open (#733)", async () => {
    const { controlPlane, created, deps, env } = await harness();
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
    const { controlPlane, deps, env } = await harness("0");
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
    const { controlPlane, deps, env } = await harness("1");
    try {
      expect(await admitSignIn("ana@example.com", env, deps)).toBe(true);
    } finally {
      controlPlane.close();
    }
  });

  test("sends a refused identity to the honest «hoy estamos llenos» page", async () => {
    const { controlPlane, deps, env } = await harness("0");
    try {
      expect(await admitSignIn("leo@example.com", env, deps)).toBe(
        PROVISIONING_CLOSED_LOGIN_PATH,
      );
      expect(PROVISIONING_CLOSED_LOGIN_PATH).toBe("/login?registro=lleno");
    } finally {
      controlPlane.close();
    }
  });
});
