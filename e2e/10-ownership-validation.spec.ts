/**
 * Journey 10: Ownership split validation
 *
 * The server-side resolveOwnershipSplit() preserves explicit custom
 * percentages, while validation rejects totals different from exactly 100 %.
 * This journey verifies:
 *   1. Submitting custom values that sum to 100 % is accepted (no error).
 *   2. The stored ownership appears in the table for both members' scopes.
 *
 * Requires at least 2 active members (from journey 2).
 */

import { test, expect } from "./fixtures";

test("ownership: valid custom split is accepted and asset visible in both scopes", async ({
  page,
}) => {
  await page.goto("/patrimonio/nuevo-activo");
  await expect(page.getByRole("heading", { name: "Nuevo activo" })).toBeVisible();

  const ownershipFieldset = page.getByRole("group", { name: "Propiedad" });
  const fieldsetVisible = await ownershipFieldset.isVisible();

  if (!fieldsetVisible) {
    // Only one member — ownership validation doesn't apply; skip.
    test.skip();
    return;
  }

  // 1. Fill basic fields
  await page.getByLabel("Nombre del activo").fill("Activo Split Test");
  await page.getByLabel("Valor actual en EUR").fill("5000");

  // 2. Open the Personalizado <details> via JS and collect input names
  const customDetails = ownershipFieldset.locator("details.ownerCustomDetails");
  const ownerInputNames = await customDetails.evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
    const inputs = Array.from(
      el.querySelectorAll<HTMLInputElement>("input[name]"),
    ).filter((i) => i.name.startsWith("owner_"));
    return inputs.map((i) => i.name);
  });
  expect(ownerInputNames.length).toBeGreaterThanOrEqual(2);

  // 3. Set custom values 60 + 40 = 100%
  //    and select the custom radio — all via JS to avoid toggling <details>.
  await page.evaluate((names) => {
    const radioEl = document.querySelector<HTMLInputElement>(
      "input[name='ownershipPreset'][value='custom']",
    );
    if (radioEl) {
      radioEl.checked = true;
      radioEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const values = ["60", "40"];
    for (const [idx, name] of names.entries()) {
      const el = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (!el) continue;
      el.value = values[idx] ?? "0";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, ownerInputNames);

  // 4. Submit — the custom split totals 100%, so this must succeed.
  await page.getByRole("button", { name: "Añadir activo" }).click();
  await expect(page).toHaveURL(/\/patrimonio/);
  await expect(page.getByRole("status")).toHaveText("Activo añadido.");

  // Extract asset ID
  const assetId = new URL(page.url()).hash.slice(1);
  expect(assetId).toBeTruthy();

  // 5. Asset row is visible in default (Hogar) scope
  await expect(page.locator(`#${assetId}`)).toBeVisible();

  // 6. Switch to second member's scope — asset should still be visible
  //    because both members have explicit ownership.
  const scopeNav = page.locator("[aria-label='Selector de scope']");
  const scopeButtons = scopeNav.getByRole("button");
  const scopeCount = await scopeButtons.count();

  if (scopeCount >= 2) {
    // Click the second scope button (index 1 = first individual member)
    await scopeButtons.nth(1).click();
    await page.waitForURL(/\/patrimonio/);
    await expect(page.locator(`#${assetId}`)).toBeVisible();
  }
});
