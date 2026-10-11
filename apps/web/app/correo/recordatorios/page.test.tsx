import { signReminderOptOutToken } from "@web/trial-emails/reminder-opt-out-token";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

import TrialRemindersPage, { metadata } from "./page";

const SECRET = "test-secret";
const saved = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  WORTHLINE_LEGAL_CONTACT_EMAIL: process.env.WORTHLINE_LEGAL_CONTACT_EMAIL,
};

beforeEach(() => {
  process.env.AUTH_SECRET = SECRET;
  delete process.env.WORTHLINE_LEGAL_CONTACT_EMAIL;
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function render(t: string | undefined): Promise<string> {
  return renderToStaticMarkup(
    await TrialRemindersPage({
      searchParams: Promise.resolve(t === undefined ? {} : { t }),
    }),
  );
}

describe("/correo/recordatorios (#1173)", () => {
  test("a valid link explains what stops and offers the button — opening it changes nothing", async () => {
    const html = await render(signReminderOptOutToken("user-1", SECRET));

    expect(html).toContain("un aviso antes de que termine y otro cuando termina");
    expect(html).toContain("No quiero recibir estos avisos");
    expect(html).toContain('type="hidden"');
  });

  test("a broken or forged link offers no button, and the contact when there is one", async () => {
    process.env.WORTHLINE_LEGAL_CONTACT_EMAIL = "hola@example.com";

    for (const t of [undefined, "basura", signReminderOptOutToken("user-1", "other")]) {
      const html = await render(t);
      expect(html).toContain("Este enlace no es válido o está incompleto");
      expect(html).toContain("mailto:hola@example.com");
      expect(html).not.toContain("No quiero recibir estos avisos");
    }
  });

  test("never shown to search engines", () => {
    expect(metadata.robots).toEqual({ follow: false, index: false });
  });
});
