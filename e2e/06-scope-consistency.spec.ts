/**
 * Journey 6: Scope consistency
 *
 * The workspace has two members (TestUser + Socio from journey 2).
 * Switch to a member scope → headline and /patrimonio totals reconcile; scope
 * survives navigation (cookie present after reload). (#153 collapsed the
 * standalone /inversiones section; investments now live in /patrimonio.)
 */

import { expect, test } from "./fixtures";

function parseEuroMinor(text: string | null): number {
  expect(text).toBeTruthy();

  const normalized = text!
    .replace(/\u00a0/g, " ")
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const value = Number(normalized);

  expect(Number.isFinite(value)).toBe(true);

  return Math.round(value * 100);
}

test("scope consistency: switch member scope → reconciled views → survives reload", async ({
  page,
}) => {
  await page.goto("/");

  const scopeTabs = page.getByRole("navigation", { name: "Selector de ámbito" });
  await expect(scopeTabs).toBeVisible();
  const scopeButtons = scopeTabs.getByRole("button");
  const count = await scopeButtons.count();
  expect(count).toBeGreaterThanOrEqual(3);

  const activeScopeLabel = async () =>
    (await scopeTabs.locator(".scopeTabBtn.active").textContent())?.trim() ?? "";
  const readHeadlineMinor = async () =>
    parseEuroMinor(
      await page
        .getByRole("region", { name: "Resumen patrimonial" })
        .locator(".headline strong")
        .textContent(),
    );

  await expect(scopeButtons.first()).toHaveText("Hogar");
  expect(await activeScopeLabel()).toBe("Hogar");
  const householdTotal = await readHeadlineMinor();
  const memberLabels = (await scopeButtons.allTextContents())
    .map((label) => label.trim())
    .filter((label) => label && label !== "Hogar");
  expect(memberLabels.length).toBeGreaterThanOrEqual(2);

  const memberTotals: number[] = [];

  for (const label of memberLabels) {
    const memberButton = scopeTabs.getByRole("button", { name: label });
    await memberButton.click();
    await expect(page).toHaveURL(/[?&]scope=/);
    expect(await activeScopeLabel()).toBe(label);
    memberTotals.push(await readHeadlineMinor());
  }

  const memberTotal = memberTotals.reduce((sum, value) => sum + value, 0);
  expect(memberTotal).toBe(householdTotal);

  // Restore the first member scope; the reload assertion below must prove this
  // exact tab survived instead of falling back to Hogar.
  const selectedMemberLabel = memberLabels[0]!;
  await scopeTabs.getByRole("button", { name: selectedMemberLabel }).click();
  await expect(page).toHaveURL(/[?&]scope=/);
  expect(await activeScopeLabel()).toBe(selectedMemberLabel);
  await expect(
    page.getByRole("region", { name: "Resumen patrimonial" }).locator(".headline strong"),
  ).toBeVisible();

  await page.goto("/patrimonio");
  await expect(page.getByRole("heading", { name: "Patrimonio" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Activos" })).toBeVisible();

  await page.goto("/");
  await page.reload();
  await expect(page.getByRole("heading", { name: "worthline" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Resumen patrimonial" }).locator(".headline strong"),
  ).toBeVisible();
  expect(await activeScopeLabel()).toBe(selectedMemberLabel);

  await page.goto("/patrimonio");
  await expect(page.getByRole("heading", { name: "Patrimonio" })).toBeVisible();
  expect(await activeScopeLabel()).toBe(selectedMemberLabel);
});
