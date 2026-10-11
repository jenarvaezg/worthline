import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlaneStore, type StartedTrial } from "@worthline/db";
import { afterAll, describe, expect, test, vi } from "vitest";

import {
  runTrialEmailPass,
  scheduleWelcomeEmail,
  sendWelcomeEmail,
} from "./trial-email-wiring";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { force: true, recursive: true });
});

const MAIL_ENV = {
  AUTH_SECRET: "test-secret",
  RESEND_API_KEY: "re_test",
  WORTHLINE_EMAIL_FROM: "worthline <avisos@example.com>",
};

/** A real file-backed control plane with one identity whose trial started at `startedAt`. */
async function controlPlaneWithTrial(startedAt: string): Promise<{
  url: string;
  trial: StartedTrial;
}> {
  const dir = mkdtempSync(join(tmpdir(), "worthline-trial-email-"));
  dirs.push(dir);
  const url = `file:${join(dir, "cp.sqlite")}`;
  const store = await createControlPlaneStore({ url });
  try {
    const user = await store.findOrCreateUser("ana@example.com");
    const workspace = await store.createWorkspace({
      dbName: "wl-ana",
      dbUrl: "file:ana",
    });
    await store.recordGrant(user.id, workspace.id);
    const started = await store.startTrialIfUnused({
      now: startedAt,
      userId: user.id,
      workspaceId: workspace.id,
    });
    return {
      trial: {
        email: user.email,
        trialEndsAt: started!.trialEndsAt!,
        trialStartedAt: startedAt,
        userId: user.id,
        workspaceId: workspace.id,
      },
      url,
    };
  } finally {
    store.close();
  }
}

function resendFake() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ id: `re_${bodies.length}` });
  }) as unknown as typeof globalThis.fetch;
  return { bodies, fetch };
}

const quietLog = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() });

describe("trial email wiring (#1173)", () => {
  test("without a verified sender the pass is skipped and names what to set — the control plane is never opened", async () => {
    const log = quietLog();
    const result = await runTrialEmailPass({
      env: {
        AUTH_SECRET: "x",
        RESEND_API_KEY: "re_test",
        // Unopenable on purpose: reaching it would turn the skip into a failure.
        WORTHLINE_CONTROL_PLANE_DB_URL: "file:/nonexistent/dir/cp.sqlite",
      },
      log,
    });

    expect(result).toEqual({
      missing: ["WORTHLINE_EMAIL_FROM"],
      reason: "email_not_configured",
      status: "skipped",
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("WORTHLINE_EMAIL_FROM"),
    );
  });

  test("without a control plane there is no trial to talk about", async () => {
    expect(await runTrialEmailPass({ env: MAIL_ENV, log: quietLog() })).toEqual({
      reason: "no_control_plane",
      status: "skipped",
    });
  });

  test("the pass sends the day-2 reminder through Resend from the configured sender, once", async () => {
    const { url } = await controlPlaneWithTrial("2026-10-01T10:00:00.000Z");
    const { bodies, fetch } = resendFake();
    const options = {
      env: { ...MAIL_ENV, WORTHLINE_CONTROL_PLANE_DB_URL: url },
      fetch,
      log: quietLog(),
      now: "2026-10-02T21:00:00.000Z",
      siteUrl: "https://worthline.example",
    };

    const result = await runTrialEmailPass(options);
    expect(result).toMatchObject({ status: "ran", summary: { sent: 1 } });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      from: "worthline <avisos@example.com>",
      tags: [{ name: "kind", value: "trial_reminder" }],
      to: ["ana@example.com"],
    });

    expect(
      await runTrialEmailPass({ ...options, now: "2026-10-03T09:00:00.000Z" }),
    ).toMatchObject({ summary: { sent: 0 } });
    expect(bodies).toHaveLength(1);
  });

  test("an unreachable control plane is a failed pass, never a throw into the cron", async () => {
    const log = quietLog();
    const result = await runTrialEmailPass({
      env: {
        ...MAIL_ENV,
        WORTHLINE_CONTROL_PLANE_DB_URL: "file:/nonexistent/dir/cp.sqlite",
      },
      log,
    });
    expect(result.status).toBe("failed");
    expect(log.error).toHaveBeenCalledOnce();
  });

  test("the welcome goes out once per identity, whoever asks twice", async () => {
    const { url, trial } = await controlPlaneWithTrial("2026-10-01T10:00:00.000Z");
    const { bodies, fetch } = resendFake();
    const options = {
      env: { ...MAIL_ENV, WORTHLINE_CONTROL_PLANE_DB_URL: url },
      fetch,
      log: quietLog(),
      now: "2026-10-01T10:00:05.000Z",
    };

    expect(await sendWelcomeEmail(trial, options)).toEqual({ status: "sent" });
    // The cron's retry window sees the claim and stays quiet.
    expect(await sendWelcomeEmail(trial, options)).toEqual({ status: "already_claimed" });
    expect(
      await runTrialEmailPass({ ...options, now: "2026-10-01T21:00:00.000Z" }),
    ).toMatchObject({ summary: { sent: 0 } });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ subject: "Te damos la bienvenida a worthline" });
  });

  test("the welcome is deferred past the sign-in response, and without a request scope it is left to the cron", async () => {
    const trial: StartedTrial = {
      email: "ana@example.com",
      trialEndsAt: "2026-10-04T10:00:00.000Z",
      trialStartedAt: "2026-10-01T10:00:00.000Z",
      userId: "user-1",
      workspaceId: "ws-1",
    };
    const deferred: Array<() => Promise<unknown>> = [];
    scheduleWelcomeEmail(trial, { defer: (task) => deferred.push(task), env: {} });
    expect(deferred).toHaveLength(1);

    const log = quietLog();
    expect(() =>
      scheduleWelcomeEmail(trial, {
        defer: () => {
          throw new Error("`after` was called outside a request scope");
        },
        log,
      }),
    ).not.toThrow();
    expect(log.info).toHaveBeenCalledOnce();
  });
});
