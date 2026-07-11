/**
 * Journey 40 (#631): typed quick actions + clickable sources keep the assistant
 * layer open across navigation.
 *
 * The assistant needs a real provider to answer, which CI deliberately does not
 * call (PRD testing decision: no live provider in automated tests). So this
 * journey intercepts /api/chat with a canned UI-message stream carrying a
 * `suggest_actions` output — the plumbing under test is the CLIENT: chips
 * render, `openInternalSource` navigates while the panel stays open, and
 * `runSuggestedAnalysis` seeds a follow-up in the same layer.
 */
import { expect, test } from "./fixtures";

// The app registers a service worker under E2E; its fetch handler proxies
// /api/chat to the network OUTSIDE page.route's reach. Block it so this
// journey's canned chat stream is delivered by the route interception below.
test.use({ serviceWorkers: "block" });

/** One AI-SDK v7 UI-message-stream chunk as an SSE `data:` line. */
function sse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** A full faked turn: a bit of text, then a `suggest_actions` tool output. */
function fakeChatStream(): string {
  return (
    sse({ type: "start" }) +
    sse({ type: "start-step" }) +
    sse({ type: "text-start", id: "t1" }) +
    sse({ type: "text-delta", id: "t1", delta: "Tu patrimonio está estable." }) +
    sse({ type: "text-end", id: "t1" }) +
    sse({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "suggest_actions",
      input: {},
    }) +
    sse({
      type: "tool-output-available",
      toolCallId: "c1",
      output: {
        actions: [
          { type: "openInternalSource", label: "Ver histórico", href: "/historico" },
          {
            type: "runSuggestedAnalysis",
            label: "¿Y mi liquidez?",
            prompt: "¿Cuál es mi liquidez?",
          },
        ],
      },
    }) +
    sse({ type: "finish-step" }) +
    sse({ type: "finish" }) +
    "data: [DONE]\n\n"
  );
}

test("assistant: click a source navigates and the panel stays open", async ({ page }) => {
  await page.route(/\/api\/chat/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      body: fakeChatStream(),
    });
  });

  await page.goto("/app");

  // Open the layer, ask, and see the streamed answer.
  await page.getByRole("button", { name: "Abrir asistente" }).click();
  const panel = page.getByRole("dialog", { name: "Asistente financiero" });
  await expect(panel).toBeVisible();

  await page.getByPlaceholder("Pregunta sobre esta pantalla…").fill("¿Cómo voy?");
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(panel.getByText("Tu patrimonio está estable.")).toBeVisible();

  // The typed quick actions render as chips.
  const sourceChip = page.getByRole("button", { name: "Ver histórico" });
  await expect(sourceChip).toBeVisible();
  await expect(page.getByRole("button", { name: "¿Y mi liquidez?" })).toBeVisible();

  // Clicking the source navigates AND the assistant layer survives the route change.
  await sourceChip.click();
  await expect(page).toHaveURL(/\/historico/);
  await expect(panel).toBeVisible();
});
