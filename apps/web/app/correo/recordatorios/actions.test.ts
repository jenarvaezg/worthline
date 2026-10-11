import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWriteBlocked } from "@web/demo/write-guard";
import {
  DECLINE_IDLE,
  DECLINE_READ_ONLY_SESSION,
} from "@web/trial-emails/decline-trial-reminders";
import { signReminderOptOutToken } from "@web/trial-emails/reminder-opt-out-token";
import { createControlPlaneStore } from "@worthline/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { declineTrialRemindersAction } from "./actions";

vi.mock("@web/demo/write-guard", () => ({ isWriteBlocked: vi.fn(async () => false) }));

const SECRET = "test-secret";
let dir: string;
const saved = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  WORTHLINE_CONTROL_PLANE_DB_URL: process.env.WORTHLINE_CONTROL_PLANE_DB_URL,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worthline-decline-reminders-"));
  process.env.AUTH_SECRET = SECRET;
  process.env.WORTHLINE_CONTROL_PLANE_DB_URL = `file:${join(dir, "cp.sqlite")}`;
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(dir, { force: true, recursive: true });
});

function form(token: string): FormData {
  const data = new FormData();
  data.set("t", token);
  return data;
}

describe("declineTrialRemindersAction (#1173)", () => {
  test("stores the opt-out in the control plane for the identity in the link", async () => {
    const url = process.env.WORTHLINE_CONTROL_PLANE_DB_URL!;
    const seed = await createControlPlaneStore({ url });
    const user = await seed.findOrCreateUser("ana@example.com");
    const workspace = await seed.createWorkspace({ dbName: "wl-ana", dbUrl: "file:ana" });
    await seed.recordGrant(user.id, workspace.id);
    await seed.startTrialIfUnused({ userId: user.id, workspaceId: workspace.id });
    seed.close();

    const state = await declineTrialRemindersAction(
      DECLINE_IDLE,
      form(signReminderOptOutToken(user.id, SECRET)),
    );
    expect(state).toEqual({ status: "done" });

    const check = await createControlPlaneStore({ url });
    const marks = await check.readTrialEmailMarks(user.id);
    check.close();
    expect(marks.remindersOptedOutAt).not.toBeNull();
  });

  test("a read-only session (demo, impersonation) writes nothing, even with a valid link (#1180)", async () => {
    vi.mocked(isWriteBlocked).mockResolvedValueOnce(true);
    const state = await declineTrialRemindersAction(
      DECLINE_IDLE,
      form(signReminderOptOutToken("user-1", SECRET)),
    );
    expect(state).toEqual({ error: DECLINE_READ_ONLY_SESSION, status: "error" });
  });

  test("a link signed with another secret changes nothing", async () => {
    const state = await declineTrialRemindersAction(
      DECLINE_IDLE,
      form(signReminderOptOutToken("user-1", "other-secret")),
    );
    expect(state.status).toBe("error");
  });
});
