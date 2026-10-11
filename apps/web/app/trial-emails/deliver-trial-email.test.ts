import type { EmailMessage, SendEmailResult } from "@web/email/send-email";
import {
  type ControlPlaneStore,
  createInMemoryControlPlaneStore,
  type TrialEmailLedger,
} from "@worthline/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { deliverTrialEmail, type TrialEmailDeliveryDeps } from "./deliver-trial-email";
import { verifyReminderOptOutToken } from "./reminder-opt-out-token";

const NOW = "2026-10-01T10:05:00.000Z";
const SECRET = "test-secret";
const SITE = "https://worthline.example";

let store: ControlPlaneStore;
let userId: string;

beforeEach(async () => {
  store = await createInMemoryControlPlaneStore();
  userId = (await store.findOrCreateUser("ana@example.com")).id;
});
afterEach(() => store.close());

function deps(
  overrides: Partial<TrialEmailDeliveryDeps> = {},
): TrialEmailDeliveryDeps & { sent: EmailMessage[]; log: ReturnType<typeof fakeLog> } {
  const sent: EmailMessage[] = [];
  const log = fakeLog();
  return {
    ledger: store,
    log,
    now: NOW,
    send: async (message): Promise<SendEmailResult> => {
      sent.push(message);
      return { id: `re_${sent.length}`, status: "sent" };
    },
    sent,
    settings: {
      email: { apiKey: "re_test", from: "worthline <avisos@example.com>" },
      optOutSecret: SECRET,
      replyTo: null,
      siteUrl: SITE,
    },
    ...overrides,
  } as TrialEmailDeliveryDeps & { sent: EmailMessage[]; log: ReturnType<typeof fakeLog> };
}

function fakeLog() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

const recipient = () => ({
  email: "ana@example.com",
  trialEndsAt: "2026-10-04T10:00:00.000Z",
  userId,
});

describe("deliverTrialEmail (#1173)", () => {
  test("sends once: a second delivery of the same kind finds it claimed and mails nothing", async () => {
    const d = deps();

    expect(await deliverTrialEmail("welcome", recipient(), d)).toBe("sent");
    expect(await deliverTrialEmail("welcome", recipient(), d)).toBe("already_claimed");

    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]?.to).toBe("ana@example.com");
  });

  test("the mail carries a per-identity idempotency key and an opt-out link signed for that identity", async () => {
    const d = deps();
    await deliverTrialEmail("trial_reminder", recipient(), d);

    const [message] = d.sent;
    expect(message?.idempotencyKey).toBe(`trial-trial_reminder-${userId}`);
    const link = message?.text.match(/https:\/\/\S+\/correo\/recordatorios\?t=(\S+)/);
    expect(link).not.toBeNull();
    expect(verifyReminderOptOutToken(link![1], SECRET)).toBe(userId);
  });

  test("a failed send gives the claim back, so the next pass can retry", async () => {
    const failing = deps({
      send: async () => ({ error: "boom", httpStatus: 500, status: "failed" }),
    });
    expect(await deliverTrialEmail("welcome", recipient(), failing)).toBe("failed");
    // Logged with the identity, never the address.
    expect(failing.log.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(failing.log.error.mock.calls)).not.toContain("ana@example.com");

    const retry = deps();
    expect(await deliverTrialEmail("welcome", recipient(), retry)).toBe("sent");
  });

  test("a control-plane outage is a failed outcome, never a throw", async () => {
    const ledger: TrialEmailLedger = {
      ...store,
      claimTrialEmail: async () => {
        throw new Error("control plane down");
      },
    };
    const d = deps({ ledger });

    expect(await deliverTrialEmail("welcome", recipient(), d)).toBe("failed");
    expect(d.sent).toHaveLength(0);
  });

  test("once the provider took the mail, a failed confirmation keeps the claim: never sent twice", async () => {
    const d = deps({
      ledger: {
        ...store,
        confirmTrialEmail: async () => {
          throw new Error("write lost");
        },
      },
    });

    expect(await deliverTrialEmail("welcome", recipient(), d)).toBe("sent");
    expect(await deliverTrialEmail("welcome", recipient(), deps())).toBe(
      "already_claimed",
    );
  });
});
