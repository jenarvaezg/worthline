/**
 * Journey 41 (#632 S4 + #633 S5): screen-aware suggested prompts, plus the
 * responsive / accessibility polish of the assistant layer.
 *
 * Like journey 40, the assistant needs a real provider to answer, which CI does
 * not call. We stub /api/chat with a canned UI-message stream so the plumbing
 * under test is the CLIENT: prompts chosen by screen context, a prompt seeding
 * the conversation, keyboard close returning focus to the trigger, the context
 * live region, and the mobile drawer.
 */
import { test, expect } from "./fixtures";

// The E2E service worker proxies /api/chat past page.route; block it so this
// journey's canned stream is delivered by the interception below.
test.use({ serviceWorkers: "block" });

function sse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** A minimal faked turn: just a line of assistant text. */
function fakeChatStream(): string {
  return (
    sse({ type: "start" }) +
    sse({ type: "start-step" }) +
    sse({ type: "text-start", id: "t1" }) +
    sse({ type: "text-delta", id: "t1", delta: "Tu concentración es moderada." }) +
    sse({ type: "text-end", id: "t1" }) +
    sse({ type: "finish-step" }) +
    sse({ type: "finish" }) +
    "data: [DONE]\n\n"
  );
}

test("assistant: screen-aware prompts seed the conversation", async ({ page }) => {
  await page.route(/\/api\/chat/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      body: fakeChatStream(),
    });
  });

  // Default fallback set on the home (resumen).
  await page.goto("/");
  await page.getByRole("button", { name: "Abrir asistente" }).click();
  const panel = page.getByRole("dialog", { name: "Asistente financiero" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "¿Cómo va mi patrimonio?" }),
  ).toBeVisible();

  // Navigate to patrimonio with the panel open — prompts swap to the surface's set.
  await page.getByRole("button", { name: "Cerrar asistente" }).click();
  await page.goto("/patrimonio");
  await page.getByRole("button", { name: "Abrir asistente" }).click();
  const concentration = panel.getByRole("button", {
    name: "¿Estoy demasiado concentrado?",
  });
  await expect(concentration).toBeVisible();

  // Selecting a prompt seeds a read-only conversation: the reply arrives and the
  // starter prompts fall away (the conversation is no longer empty).
  await concentration.click();
  await expect(panel.getByText("Tu concentración es moderada.")).toBeVisible();
  await expect(concentration).toBeHidden();
});

test("assistant: keyboard close returns focus to the trigger + context is announced", async ({
  page,
}) => {
  await page.goto("/patrimonio");
  const fab = page.getByRole("button", { name: "Abrir asistente" });
  await fab.click();
  const panel = page.getByRole("dialog", { name: "Asistente financiero" });
  await expect(panel).toBeVisible();

  // The polite live region names the current surface — not a silent state change.
  await expect(panel.getByRole("status")).toContainText("Patrimonio");

  // Escape closes and focus returns to the opener, not the top of the page.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(fab).toBeFocused();
});

test("assistant: opens as a drawer on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Abrir asistente" }).click();
  const panel = page.getByRole("dialog", { name: "Asistente financiero" });
  await expect(panel).toBeVisible();
  // The mobile drawer spans the full width and does not permanently cover the app.
  const box = await panel.boundingBox();
  expect(box?.width).toBeGreaterThan(380);
  expect(box?.height).toBeLessThan(844);
});
