import type { EmailMessage, SendEmailResult } from "@web/email/send-email";
import { type ControlPlaneStore, createInMemoryControlPlaneStore } from "@worthline/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runTrialEmailSweep, type TrialEmailSweepDeps } from "./trial-email-sweep";

const SETTINGS = {
  email: { apiKey: "re_test", from: "worthline <avisos@example.com>" },
  optOutSecret: "test-secret",
  replyTo: null,
  siteUrl: "https://worthline.example",
};

let store: ControlPlaneStore;
beforeEach(async () => {
  store = await createInMemoryControlPlaneStore();
});
afterEach(() => store.close());

async function trialFor(email: string, startedAt: string): Promise<string> {
  const user = await store.findOrCreateUser(email);
  const workspace = await store.createWorkspace({
    dbName: `wl-${email}`,
    dbUrl: `file:${email}.sqlite`,
  });
  await store.recordGrant(user.id, workspace.id);
  await store.startTrialIfUnused({
    now: startedAt,
    userId: user.id,
    workspaceId: workspace.id,
  });
  return workspace.id;
}

function sweepDeps(now: string, overrides: Partial<TrialEmailSweepDeps> = {}) {
  const sent: EmailMessage[] = [];
  const deps: TrialEmailSweepDeps = {
    ledger: store,
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    now,
    pause: async () => {},
    send: async (message): Promise<SendEmailResult> => {
      sent.push(message);
      return { id: `re_${sent.length}`, status: "sent" };
    },
    settings: SETTINGS,
    ...overrides,
  };
  return { deps, sent };
}

const sentKinds = (sent: EmailMessage[]) =>
  sent.map((message) => `${message.to}:${message.tags?.[0]?.value}`).sort();

describe("runTrialEmailSweep (#1173)", () => {
  test("mails each identity what its trial owes now, and nothing to the rest", async () => {
    const NOW = "2026-10-05T09:00:00.000Z";
    await trialFor("first-day@example.com", "2026-10-05T01:00:00.000Z"); // welcome retry
    await trialFor("day-two@example.com", "2026-10-03T20:00:00.000Z"); // reminder
    await trialFor("ended@example.com", "2026-10-01T20:00:00.000Z"); // expired on the 4th
    await trialFor("long-gone@example.com", "2026-09-01T20:00:00.000Z"); // past the cutoff
    const paid = await trialFor("paid@example.com", "2026-10-03T20:00:00.000Z");
    await store.grantWorkspacePremium({ premiumUntil: null, workspaceId: paid });

    const { deps, sent } = sweepDeps(NOW);
    const summary = await runTrialEmailSweep(deps);

    expect(sentKinds(sent)).toEqual([
      "day-two@example.com:trial_reminder",
      "ended@example.com:trial_expired",
      "first-day@example.com:welcome",
    ]);
    expect(summary).toEqual({
      alreadyClaimed: 0,
      candidates: 4,
      deferred: 0,
      due: 3,
      failed: 0,
      sent: 3,
    });
  });

  test("a second pass over the same state sends nothing", async () => {
    const NOW = "2026-10-05T09:00:00.000Z";
    await trialFor("day-two@example.com", "2026-10-03T20:00:00.000Z");

    await runTrialEmailSweep(sweepDeps(NOW).deps);
    const again = sweepDeps("2026-10-05T21:00:00.000Z");
    const summary = await runTrialEmailSweep(again.deps);

    expect(again.sent).toEqual([]);
    expect(summary.sent).toBe(0);
  });

  test("an identity that declined the reminders gets neither the reminder nor the expiry", async () => {
    await trialFor("quiet@example.com", "2026-10-03T20:00:00.000Z");
    const user = await store.findOrCreateUser("quiet@example.com");
    await store.optOutOfTrialReminders({
      at: "2026-10-03T21:00:00.000Z",
      userId: user.id,
    });

    const reminderPass = sweepDeps("2026-10-05T09:00:00.000Z");
    await runTrialEmailSweep(reminderPass.deps);
    const expiryPass = sweepDeps("2026-10-06T21:00:00.000Z");
    await runTrialEmailSweep(expiryPass.deps);

    expect([...reminderPass.sent, ...expiryPass.sent]).toEqual([]);
  });

  test("spaces the sends out, under the provider's rate limit", async () => {
    await trialFor("a@example.com", "2026-10-03T20:00:00.000Z");
    await trialFor("b@example.com", "2026-10-03T20:00:00.000Z");
    await trialFor("c@example.com", "2026-10-03T20:00:00.000Z");
    const pause = vi.fn(async (_ms: number) => {});

    await runTrialEmailSweep(sweepDeps("2026-10-05T09:00:00.000Z", { pause }).deps);

    // Between sends, never before the first one.
    expect(pause).toHaveBeenCalledTimes(2);
    expect(pause.mock.calls.every(([ms]) => (ms as number) >= 500)).toBe(true);
  });

  test("stops starting sends when the time budget runs out, and leaves the rest unclaimed for the next pass", async () => {
    await trialFor("a@example.com", "2026-10-03T20:00:00.000Z");
    await trialFor("b@example.com", "2026-10-03T20:00:00.000Z");
    let elapsed = 0;
    const clock = () => elapsed;
    const send = async (): Promise<SendEmailResult> => {
      elapsed += 60_000;
      return { id: "re_x", status: "sent" };
    };

    const first = sweepDeps("2026-10-05T09:00:00.000Z", { clock, send });
    const summary = await runTrialEmailSweep(first.deps);
    expect(summary).toMatchObject({ deferred: 1, due: 2, sent: 1 });

    const next = sweepDeps("2026-10-05T21:00:00.000Z");
    await runTrialEmailSweep(next.deps);
    expect(next.sent).toHaveLength(1);
  });
});
