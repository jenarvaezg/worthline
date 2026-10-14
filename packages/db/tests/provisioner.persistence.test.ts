import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlPlaneStore,
  createInMemoryControlPlaneStore,
} from "@db/control-plane";
import { openLibsqlClient } from "@db/libsql-client";
import { SCHEMA_VERSION } from "@db/migrate";
import {
  DailyProvisioningCapRefusedError,
  provisionWorkspaceForUser,
  type TursoPort,
} from "@db/provisioner";
import { afterAll, describe, expect, test, vi } from "vitest";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
});

/**
 * A fake Turso Platform port: "creating a database" hands back a local `file:`
 * URL in a temp dir, so the provisioner runs the real migration against a real
 * libSQL database — no network, no Turso account.
 */
function fakeTurso(dir: string): {
  port: TursoPort;
  created: string[];
  deleted: string[];
  tokens: string[];
} {
  const created: string[] = [];
  const deleted: string[] = [];
  const tokens: string[] = [];
  return {
    created,
    deleted,
    tokens,
    port: {
      async createDatabase(name) {
        created.push(name);
        return { name, url: `file:${join(dir, `${name}.sqlite`)}` };
      },
      async createDatabaseToken(name) {
        const jwt = `scoped-token-for-${name}`;
        tokens.push(jwt);
        return { jwt };
      },
      async deleteDatabase(name) {
        deleted.push(name);
      },
    },
  };
}

describe("workspace provisioner", () => {
  test("provisions a fresh workspace: creates a db, migrates it, writes workspace + grant", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-provision-"));
    try {
      const ws = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "ana@example.com",
      );

      // 1. A database was created via the Turso port.
      expect(created).toHaveLength(1);
      expect(ws.dbName).toBe(created[0]);

      // 2. workspace + grant rows were written in the control plane.
      const user = await cp.findOrCreateUser("ana@example.com");
      expect(await cp.readGrant(user.id, ws.id)).not.toBeNull();

      // 3. The new workspace database was migrated to the current schema.
      //    Open a RAW client (not createWorthlineStoreUnsafe, which would migrate it
      //    itself) so this asserts the provisioner did the migration.
      const raw = openLibsqlClient({ url: ws.dbUrl });
      const version = Number(
        (await raw.execute("PRAGMA user_version")).rows[0]!["user_version"],
      );
      raw.close();
      expect(version).toBe(SCHEMA_VERSION);
    } finally {
      cp.close();
    }
  });

  test("mints a per-workspace Turso token and stores it (#1185)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, tokens } = fakeTurso(tempDir("worthline-provision-token-"));
    const migrateTargets: Array<{ url: string; authToken?: string }> = [];
    try {
      const ws = await provisionWorkspaceForUser(
        {
          controlPlane: cp,
          turso: port,
          // A shared group token must NOT be what opens the fresh DB — the
          // scoped per-database JWT is the blast-radius reduction (#1185).
          groupAuthToken: "group-token-must-not-open-workspace",
          openAndMigrate: async (target) => {
            migrateTargets.push(target);
          },
        },
        "ana@example.com",
      );

      expect(tokens).toEqual([`scoped-token-for-${ws.dbName}`]);
      expect(ws.dbAuthToken).toBe(`scoped-token-for-${ws.dbName}`);
      expect(migrateTargets).toEqual([
        { url: ws.dbUrl, authToken: `scoped-token-for-${ws.dbName}` },
      ]);

      const listed = await cp.listAllWorkspaces();
      expect(listed[0]?.dbAuthToken).toBe(`scoped-token-for-${ws.dbName}`);
    } finally {
      cp.close();
    }
  });

  test("two accounts get distinct per-workspace tokens (#1185)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port } = fakeTurso(tempDir("worthline-provision-token-iso-"));
    try {
      const ana = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "ana@example.com",
      );
      const leo = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "leo@example.com",
      );

      expect(ana.dbAuthToken).toBeTruthy();
      expect(leo.dbAuthToken).toBeTruthy();
      expect(leo.dbAuthToken).not.toBe(ana.dbAuthToken);
    } finally {
      cp.close();
    }
  });

  test("a fresh provision starts the identity's trial (#1128, PRD #1160 S1)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port } = fakeTurso(tempDir("worthline-provision-trial-"));
    try {
      const ws = await provisionWorkspaceForUser(
        { controlPlane: cp, now: () => "2026-07-22T12:00:00.000Z", turso: port },
        "ana@example.com",
      );

      const entitlement = await cp.readWorkspaceEntitlement(ws.id);
      expect(entitlement?.plan).toBe("trial");
      expect(entitlement?.trialEndsAt).toBe("2026-07-25T12:00:00.000Z");
    } finally {
      cp.close();
    }
  });

  test("a fresh provision hands the started trial to onTrialStarted — the welcome's trigger (#1173)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port } = fakeTurso(tempDir("worthline-provision-trial-hook-"));
    const started: unknown[] = [];
    try {
      const ws = await provisionWorkspaceForUser(
        {
          controlPlane: cp,
          now: () => "2026-07-22T12:00:00.000Z",
          onTrialStarted: (trial) => {
            started.push(trial);
          },
          turso: port,
        },
        "ana@example.com",
      );

      const user = await cp.findOrCreateUser("ana@example.com");
      expect(started).toEqual([
        {
          email: "ana@example.com",
          trialEndsAt: "2026-07-25T12:00:00.000Z",
          trialStartedAt: "2026-07-22T12:00:00.000Z",
          userId: user.id,
          workspaceId: ws.id,
        },
      ]);
    } finally {
      cp.close();
    }
  });

  test("no trial, no announcement: an identity that already used its trial is not welcomed again (#1173)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port } = fakeTurso(tempDir("worthline-provision-trial-hook-used-"));
    const started: unknown[] = [];
    try {
      const user = await cp.findOrCreateUser("ana@example.com");
      const old = await cp.createWorkspace({
        dbName: "wl-old",
        dbUrl: "file:old.sqlite",
      });
      await cp.startTrialIfUnused({ userId: user.id, workspaceId: old.id });

      await provisionWorkspaceForUser(
        {
          controlPlane: cp,
          onTrialStarted: (trial) => {
            started.push(trial);
          },
          turso: port,
        },
        "ana@example.com",
      );

      expect(started).toEqual([]);
    } finally {
      cp.close();
    }
  });

  test("a failing onTrialStarted is swallowed: the login keeps its workspace and its trial (#1173)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port } = fakeTurso(tempDir("worthline-provision-trial-hook-fail-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = await provisionWorkspaceForUser(
        {
          controlPlane: cp,
          onTrialStarted: async () => {
            throw new Error("mail outage");
          },
          turso: port,
        },
        "ana@example.com",
      );

      expect((await cp.readWorkspaceEntitlement(ws.id))?.plan).toBe("trial");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      cp.close();
    }
  });

  test("is idempotent: a second login for the same account reuses the workspace, no new db", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-provision-idem-"));
    try {
      const first = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "ana@example.com",
      );
      const second = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "ana@example.com",
      );

      expect(second.id).toBe(first.id);
      expect(created).toHaveLength(1);
    } finally {
      cp.close();
    }
  });

  test("two different accounts get two different, isolated workspaces", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-provision-iso-"));
    try {
      const ana = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "ana@example.com",
      );
      const leo = await provisionWorkspaceForUser(
        { controlPlane: cp, turso: port },
        "leo@example.com",
      );

      expect(leo.id).not.toBe(ana.id);
      expect(leo.dbName).not.toBe(ana.dbName);
      expect(leo.dbUrl).not.toBe(ana.dbUrl);
      expect(created).toHaveLength(2);
    } finally {
      cp.close();
    }
  });

  test("concurrent first logins for the same account converge on one workspace (#733)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created, deleted } = fakeTurso(tempDir("worthline-provision-race-"));
    try {
      // Barrier inside the injected openAndMigrate: both provisions must pass
      // the "already has a workspace?" check before either records its grant —
      // the double-fire interleaving (two tabs / retried lambda).
      let arrived = 0;
      let release = () => {};
      const bothPastTheCheck = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deps = {
        controlPlane: cp,
        turso: port,
        openAndMigrate: async () => {
          arrived += 1;
          if (arrived === 2) release();
          await bothPastTheCheck;
        },
      };

      const [first, second] = await Promise.all([
        provisionWorkspaceForUser(deps, "ana@example.com"),
        provisionWorkspaceForUser(deps, "ana@example.com"),
      ]);

      // Both logins land on the same workspace…
      expect(second.id).toBe(first.id);

      // …exactly one workspace + grant survive in the control plane…
      const user = await cp.findOrCreateUser("ana@example.com");
      expect(await cp.listOwnedWorkspacesForUser(user.id)).toHaveLength(1);
      expect(await cp.listAllWorkspaces()).toHaveLength(1);

      // …and the loser's database was cleaned up via the port.
      expect(created).toHaveLength(2);
      expect(deleted).toHaveLength(1);
      expect(created).toContain(deleted[0]);
      expect(deleted[0]).not.toBe(first.dbName);

      // Exactly ONE trial was started, on the surviving workspace: the loser
      // returns the winner's workspace before ever reaching the trial start,
      // so the identity's single trial (#1128) lands on the winner's row.
      const entitlement = await cp.readWorkspaceEntitlement(first.id);
      expect(entitlement?.plan).toBe("trial");
      expect(
        await cp.startTrialIfUnused({ userId: user.id, workspaceId: first.id }),
      ).toBeNull();
    } finally {
      cp.close();
    }
  });

  test("a trial-start failure is swallowed: login still gets its workspace, which reads free", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port } = fakeTurso(tempDir("worthline-provision-trial-fail-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = {
        ...cp,
        startTrialIfUnused: async () => {
          throw new Error("control plane hiccup");
        },
      };
      const ws = await provisionWorkspaceForUser(
        { controlPlane: failing, turso: port },
        "ana@example.com",
      );

      // The provision itself survived (workspace + grant written)…
      const user = await cp.findOrCreateUser("ana@example.com");
      expect(await cp.readGrant(user.id, ws.id)).not.toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      // …and the workspace simply reads as free (no entitlement row) — the
      // admin's manual grant is the recovery palanca.
      expect(await cp.readWorkspaceEntitlement(ws.id)).toBeNull();
    } finally {
      warn.mockRestore();
      cp.close();
    }
  });
});

/**
 * The daily provisioning cap (#1175). The limits below are illustrative — the
 * real figure lives only in the deployment's env. The hostile cases: a returning
 * user on a full day, sign-ups competing for the last place, and the reset at the
 * UTC day change.
 */
describe("workspace provisioner · daily provisioning cap (#1175)", () => {
  const MORNING = "2026-03-14T09:00:00.000Z";
  const limited = (limit: number) => ({ kind: "limited" as const, limit });

  /**
   * How many workspaces `day` has provisioned, read through the cap port: a claim
   * under a limit nothing reaches reports the count it lands on, then goes back.
   */
  async function provisionedOn(
    cp: Awaited<ReturnType<typeof createInMemoryControlPlaneStore>>,
    day: string,
  ): Promise<number> {
    const probe = await cp.claimDailyProvisioning(day, Number.MAX_SAFE_INTEGER);
    await cp.releaseDailyProvisioning(day);
    return probe.provisionedToday - 1;
  }

  test("a returning user on a full day still gets their workspace, and is not counted", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-cap-returning-"));
    try {
      const deps = {
        controlPlane: cp,
        now: () => MORNING,
        provisioningCap: limited(1),
        turso: port,
      };
      const ana = await provisionWorkspaceForUser(deps, "ana@example.com");
      await expect(provisionWorkspaceForUser(deps, "leo@example.com")).rejects.toThrow(
        DailyProvisioningCapRefusedError,
      );

      // The day is full — and Ana's next sign-in is untouched by it.
      const again = await provisionWorkspaceForUser(deps, "ana@example.com");
      expect(again.id).toBe(ana.id);
      expect(created).toHaveLength(1);
      expect(await provisionedOn(cp, "2026-03-14")).toBe(1);

      // Nor does any closed cap — a zero limit, a typo, a forgotten variable —
      // ever lock an existing user out.
      for (const provisioningCap of [
        limited(0),
        { configuredValue: "cinco", kind: "misconfigured" as const },
        { kind: "unset" as const },
      ]) {
        const closed = await provisionWorkspaceForUser(
          { ...deps, provisioningCap },
          "ana@example.com",
        );
        expect(closed.id).toBe(ana.id);
      }
    } finally {
      cp.close();
    }
  });

  test("a new identity past the cap is refused before any cost: no database, no user row", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-cap-refused-"));
    try {
      const deps = {
        controlPlane: cp,
        now: () => MORNING,
        provisioningCap: limited(1),
        turso: port,
      };
      await provisionWorkspaceForUser(deps, "ana@example.com");

      const refusal = await provisionWorkspaceForUser(deps, "leo@example.com").catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(DailyProvisioningCapRefusedError);
      expect((refusal as DailyProvisioningCapRefusedError).refusal).toEqual({
        dayKey: "2026-03-14",
        policy: limited(1),
        provisionedToday: 1,
      });

      expect(created).toHaveLength(1);
      // The refused identity left nothing behind in the control plane.
      expect(await cp.findUserByEmail("leo@example.com")).toBeNull();
    } finally {
      cp.close();
    }
  });

  test("a misconfigured or unset cap refuses new identities and says which it was", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-cap-closed-"));
    try {
      for (const provisioningCap of [
        { configuredValue: "cinco", kind: "misconfigured" as const },
        { kind: "unset" as const },
      ]) {
        const refusal = await provisionWorkspaceForUser(
          { controlPlane: cp, now: () => MORNING, provisioningCap, turso: port },
          "leo@example.com",
        ).catch((error: unknown) => error);
        expect((refusal as DailyProvisioningCapRefusedError).refusal).toEqual({
          dayKey: "2026-03-14",
          policy: provisioningCap,
          provisionedToday: 0,
        });
      }
      expect(created).toHaveLength(0);
    } finally {
      cp.close();
    }
  });

  test("new identities competing for the last places: exactly the limit is provisioned", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-cap-race-"));
    try {
      // The two admitted sign-ups are held inside their migration until both
      // are in, so the other claims are answered while those two are still
      // mid-creation. The in-memory client interleaves the statements rather
      // than running them in parallel; the atomic claim is what this pins.
      let arrived = 0;
      let release = () => {};
      const bothAdmittedInside = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deps = {
        controlPlane: cp,
        now: () => MORNING,
        openAndMigrate: async () => {
          arrived += 1;
          if (arrived === 2) release();
          await bothAdmittedInside;
        },
        provisioningCap: limited(2),
        turso: port,
      };

      const outcomes = await Promise.allSettled(
        ["a", "b", "c", "d", "e"].map((name) =>
          provisionWorkspaceForUser(deps, `${name}@example.com`),
        ),
      );

      const provisioned = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const refused = outcomes.filter(
        (outcome) =>
          outcome.status === "rejected" &&
          outcome.reason instanceof DailyProvisioningCapRefusedError,
      );
      expect(provisioned).toHaveLength(2);
      expect(refused).toHaveLength(3);
      expect(created).toHaveLength(2);
      expect(await cp.listAllWorkspaces()).toHaveLength(2);
      expect(await provisionedOn(cp, "2026-03-14")).toBe(2);
    } finally {
      cp.close();
    }
  });

  test("the cap opens again when the UTC day changes", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-cap-reset-"));
    let now = "2026-03-14T23:59:59.000Z";
    try {
      const deps = {
        controlPlane: cp,
        now: () => now,
        provisioningCap: limited(1),
        turso: port,
      };
      await provisionWorkspaceForUser(deps, "ana@example.com");
      await expect(provisionWorkspaceForUser(deps, "leo@example.com")).rejects.toThrow(
        DailyProvisioningCapRefusedError,
      );

      now = "2026-03-15T00:00:00.000Z";
      const leo = await provisionWorkspaceForUser(deps, "leo@example.com");
      expect(leo.id).toBeTruthy();
      expect(created).toHaveLength(2);
      expect(await provisionedOn(cp, "2026-03-14")).toBe(1);
      expect(await provisionedOn(cp, "2026-03-15")).toBe(1);
    } finally {
      cp.close();
    }
  });

  test("a provision that fails is given back to the day it was claimed on", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port } = fakeTurso(tempDir("worthline-cap-failure-"));
    // The claim happens a second before midnight; the failure lands after it.
    let now = "2026-03-14T23:59:59.000Z";
    try {
      const failing: TursoPort = {
        ...port,
        async createDatabase() {
          now = "2026-03-15T00:00:01.000Z";
          throw new Error("Turso Platform API unavailable");
        },
      };
      await expect(
        provisionWorkspaceForUser(
          {
            controlPlane: cp,
            now: () => now,
            provisioningCap: limited(1),
            turso: failing,
          },
          "ana@example.com",
        ),
      ).rejects.toThrow("Turso Platform API unavailable");

      // The outage did not eat the day's only place…
      expect(await provisionedOn(cp, "2026-03-14")).toBe(0);
      expect(await provisionedOn(cp, "2026-03-15")).toBe(0);
      // …so the retry, on the healthy port, gets in.
      now = "2026-03-14T23:59:59.000Z";
      const ws = await provisionWorkspaceForUser(
        { controlPlane: cp, now: () => now, provisioningCap: limited(1), turso: port },
        "ana@example.com",
      );
      expect(ws.id).toBeTruthy();
    } finally {
      cp.close();
    }
  });

  describe("a provision that fails after the database exists deletes it (#1807)", () => {
    const failurePoints: Array<{
      step: string;
      fail: (deps: { controlPlane: ControlPlaneStore; turso: TursoPort }) => {
        openAndMigrate?: () => Promise<void>;
        turso: TursoPort;
      };
    }> = [
      {
        step: "createDatabaseToken",
        fail: ({ turso }) => ({
          turso: {
            ...turso,
            async createDatabaseToken() {
              throw new Error("createDatabaseToken failed");
            },
          },
        }),
      },
      {
        step: "openAndMigrate",
        fail: ({ turso }) => ({
          openAndMigrate: async () => {
            throw new Error("openAndMigrate failed");
          },
          turso,
        }),
      },
      {
        step: "createWorkspace",
        fail: ({ controlPlane, turso }) => {
          vi.spyOn(controlPlane, "createWorkspace").mockRejectedValueOnce(
            new Error("createWorkspace failed"),
          );
          return { turso };
        },
      },
      {
        step: "recordGrant",
        fail: ({ controlPlane, turso }) => {
          vi.spyOn(controlPlane, "recordGrant").mockRejectedValueOnce(
            new Error("recordGrant failed"),
          );
          return { turso };
        },
      },
    ];

    for (const { step, fail } of failurePoints) {
      test(`a failing ${step} deletes the database and gives the day's place back`, async () => {
        const cp = await createInMemoryControlPlaneStore();
        const { port, created, deleted } = fakeTurso(
          tempDir(`worthline-cap-orphan-${step}-`),
        );
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const failing = fail({ controlPlane: cp, turso: port });
          await expect(
            provisionWorkspaceForUser(
              {
                controlPlane: cp,
                now: () => MORNING,
                provisioningCap: limited(1),
                ...failing,
              },
              "ana@example.com",
            ),
          ).rejects.toThrow(`${step} failed`);

          expect(created).toHaveLength(1);
          expect(deleted).toEqual(created);
          expect(await cp.listAllWorkspaces()).toEqual([]);
          expect(warn).not.toHaveBeenCalled();
          expect(await provisionedOn(cp, "2026-03-14")).toBe(0);
        } finally {
          warn.mockRestore();
          cp.close();
        }
      });
    }

    test("a cleanup that fails too names the orphan database for an operator", async () => {
      const cp = await createInMemoryControlPlaneStore();
      const { port, created } = fakeTurso(tempDir("worthline-cap-orphan-undeletable-"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(
          provisionWorkspaceForUser(
            {
              controlPlane: cp,
              now: () => MORNING,
              openAndMigrate: async () => {
                throw new Error("migration rejected by Turso");
              },
              provisioningCap: limited(1),
              turso: {
                ...port,
                async deleteDatabase() {
                  throw new Error("Turso Platform API unavailable");
                },
              },
            },
            "ana@example.com",
          ),
        ).rejects.toThrow("migration rejected by Turso");

        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0]?.[0])).toContain(created[0]);
        expect(await provisionedOn(cp, "2026-03-14")).toBe(0);
      } finally {
        warn.mockRestore();
        cp.close();
      }
    });

    test("a failure inside createDatabase has nothing to delete", async () => {
      const cp = await createInMemoryControlPlaneStore();
      const { port, deleted } = fakeTurso(tempDir("worthline-cap-orphan-none-"));
      try {
        await expect(
          provisionWorkspaceForUser(
            {
              controlPlane: cp,
              now: () => MORNING,
              provisioningCap: limited(1),
              turso: {
                ...port,
                async createDatabase() {
                  throw new Error("Turso Platform API unavailable");
                },
              },
            },
            "ana@example.com",
          ),
        ).rejects.toThrow("Turso Platform API unavailable");

        expect(deleted).toEqual([]);
        expect(await provisionedOn(cp, "2026-03-14")).toBe(0);
      } finally {
        cp.close();
      }
    });
  });

  test("a double-fired first login is counted ONCE: the race loser gives its claim back (#733)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port } = fakeTurso(tempDir("worthline-cap-double-fire-"));
    try {
      let arrived = 0;
      let release = () => {};
      const bothPastTheCheck = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deps = {
        controlPlane: cp,
        now: () => MORNING,
        openAndMigrate: async () => {
          arrived += 1;
          if (arrived === 2) release();
          await bothPastTheCheck;
        },
        provisioningCap: limited(2),
        turso: port,
      };

      const [first, second] = await Promise.all([
        provisionWorkspaceForUser(deps, "ana@example.com"),
        provisionWorkspaceForUser(deps, "ana@example.com"),
      ]);
      expect(second.id).toBe(first.id);
      expect(await provisionedOn(cp, "2026-03-14")).toBe(1);

      // The second place is still there for somebody else today.
      const leo = await provisionWorkspaceForUser(
        {
          controlPlane: cp,
          now: () => MORNING,
          provisioningCap: limited(2),
          turso: port,
        },
        "leo@example.com",
      );
      expect(leo.id).not.toBe(first.id);
    } finally {
      cp.close();
    }
  });

  test("uncapped, provisioning is not even counted: open registration by design (#733)", async () => {
    const cp = await createInMemoryControlPlaneStore();
    const { port, created } = fakeTurso(tempDir("worthline-cap-none-"));
    try {
      for (const name of ["a", "b", "c"]) {
        await provisionWorkspaceForUser(
          {
            controlPlane: cp,
            now: () => MORNING,
            provisioningCap: { kind: "uncapped" },
            turso: port,
          },
          `${name}@example.com`,
        );
      }
      expect(created).toHaveLength(3);
      expect(await provisionedOn(cp, "2026-03-14")).toBe(0);
    } finally {
      cp.close();
    }
  });

  describe("a viewer grant is never ownership (#1841)", () => {
    test("an identity that only views a workspace is provisioned its own, through the cap", async () => {
      const cp = await createInMemoryControlPlaneStore();
      const { port, created } = fakeTurso(tempDir("worthline-cap-viewer-only-"));
      try {
        const deps = {
          controlPlane: cp,
          now: () => MORNING,
          provisioningCap: limited(2),
          turso: port,
        };
        const ana = await provisionWorkspaceForUser(deps, "ana@example.com");
        // Ana shared hers: Leo exists as a bare user row with a viewer grant.
        const leoUser = await cp.findOrCreateUser("leo@example.com");
        await cp.recordGrant(leoUser.id, ana.id, "viewer");

        const leo = await provisionWorkspaceForUser(deps, "leo@example.com");

        expect(leo.id).not.toBe(ana.id);
        expect(created).toHaveLength(2);
        expect(await provisionedOn(cp, "2026-03-14")).toBe(2);
        expect(
          (await cp.listOwnedWorkspacesForUser(leoUser.id)).map((w) => w.id),
        ).toEqual([leo.id]);
        // And the viewer grant is still there, untouched.
        expect((await cp.readGrant(leoUser.id, ana.id))?.role).toBe("viewer");
      } finally {
        cp.close();
      }
    });

    test("an identity that only views a workspace is refused on a full day, never handed the shared one", async () => {
      const cp = await createInMemoryControlPlaneStore();
      const { port } = fakeTurso(tempDir("worthline-cap-viewer-full-"));
      try {
        const deps = {
          controlPlane: cp,
          now: () => MORNING,
          provisioningCap: limited(1),
          turso: port,
        };
        const ana = await provisionWorkspaceForUser(deps, "ana@example.com");
        const leoUser = await cp.findOrCreateUser("leo@example.com");
        await cp.recordGrant(leoUser.id, ana.id, "viewer");

        await expect(provisionWorkspaceForUser(deps, "leo@example.com")).rejects.toThrow(
          DailyProvisioningCapRefusedError,
        );
      } finally {
        cp.close();
      }
    });

    test("an owner who also views another workspace keeps resolving to their own", async () => {
      const cp = await createInMemoryControlPlaneStore();
      const { port, created } = fakeTurso(tempDir("worthline-cap-owner-viewer-"));
      try {
        const deps = { controlPlane: cp, now: () => MORNING, turso: port };
        const ana = await provisionWorkspaceForUser(deps, "ana@example.com");
        const leo = await provisionWorkspaceForUser(deps, "leo@example.com");
        const leoUser = await cp.findOrCreateUser("leo@example.com");
        // Leo's viewer grant on Ana's workspace is OLDER than nothing — but even
        // a grant listed first must not be read as his.
        await cp.recordGrant(leoUser.id, ana.id, "viewer");

        const again = await provisionWorkspaceForUser(deps, "leo@example.com");
        expect(again.id).toBe(leo.id);
        expect(again.dbAuthToken).toBe(`scoped-token-for-${leo.dbName}`);
        expect(created).toHaveLength(2);
      } finally {
        cp.close();
      }
    });

    test("the provision mints the full-access token, never a read-only one", async () => {
      const cp = await createInMemoryControlPlaneStore();
      const authorizations: string[] = [];
      const { port } = fakeTurso(tempDir("worthline-provision-full-access-"));
      try {
        await provisionWorkspaceForUser(
          {
            controlPlane: cp,
            now: () => MORNING,
            openAndMigrate: async () => {},
            turso: {
              ...port,
              async createDatabaseToken(name, authorization) {
                authorizations.push(authorization);
                return port.createDatabaseToken(name, authorization);
              },
            },
          },
          "ana@example.com",
        );
        expect(authorizations).toEqual(["full-access"]);
      } finally {
        cp.close();
      }
    });
  });
});
