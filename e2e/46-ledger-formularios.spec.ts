/**
 * Journey 46: «Libro mayor» slice 3 — Formularios (#908).
 *
 * The form surfaces (altas, ediciones, objetivos) drop their floating cards for
 * open reglada «papel» sections, and their controls wear the canon form
 * primitive: panel paper, a --line-strong rule, square 4px corners, and a --blue
 * rule under focus. The debt chapter opens on the structural debit rule, never
 * --red (which stays reserved for movement). Guards the canon
 * (docs/design-system.md §3, §5) the captures (#826) sign off. Info, routes,
 * calculations and interaction are unchanged — this is a visual layer only.
 */

import { expect, test } from "./fixtures";

const PANEL = "rgb(247, 247, 238)"; // --panel #f7f7ee
const LINE_STRONG = "rgb(93, 108, 102)"; // --line-strong #5d6c66
const BLUE = "rgb(31, 77, 116)"; // --blue #1f4d74
const DEBIT_RULE = "rgb(160, 58, 40)"; // --debit-rule #a03a28
const INK = "rgb(28, 36, 32)"; // --ink #1c2420
const TRANSPARENT = "rgba(0, 0, 0, 0)";

test("objetivos panels are open reglada chapters, not floating cards", async ({
  page,
}) => {
  await page.goto("/objetivos");

  // Exact match: the «Niveles FIRE» rail is also a region whose name contains
  // "FIRE", so a substring match is ambiguous — target the panel labelled
  // exactly "FIRE".
  const fire = page.getByRole("region", { name: "FIRE", exact: true });
  await expect(fire).toBeVisible();

  const style = await fire.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      backgroundColor: s.backgroundColor,
      borderRadius: s.borderRadius,
      borderTopColor: s.borderTopColor,
      borderTopStyle: s.borderTopStyle,
      borderTopWidth: s.borderTopWidth,
      boxShadow: s.boxShadow,
    };
  });
  expect(style).toEqual({
    backgroundColor: TRANSPARENT,
    borderRadius: "0px",
    borderTopColor: INK,
    borderTopStyle: "solid",
    borderTopWidth: "2px",
    boxShadow: "none",
  });
});

test("goal form controls wear the canon form primitive with a blue focus rule", async ({
  page,
}) => {
  await page.goto("/objetivos");

  // The «Nuevo objetivo» name field uses the base control rule (no bespoke
  // override), so it proves the shared primitive (canon §5).
  const nameInput = page.locator("#goalCreateForm input[name='name']");
  await expect(nameInput).toBeVisible();

  const resting = await nameInput.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      backgroundColor: s.backgroundColor,
      borderRadius: s.borderTopLeftRadius,
      borderTopColor: s.borderTopColor,
    };
  });
  expect(resting).toEqual({
    backgroundColor: PANEL,
    borderRadius: "4px",
    borderTopColor: LINE_STRONG,
  });

  // Focus inks the rule blue (the pen) — a text field always matches
  // :focus-visible on focus.
  await nameInput.click();
  expect(await nameInput.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(
    BLUE,
  );
});

test("the debt drawer opens on the structural debit rule, never red", async ({
  page,
}) => {
  await page.goto("/patrimonio/anadir");

  await page.locator('label.simpleDrawerCard:has(input[value="deuda"])').click();

  const debtPane = page.locator('.simpleDrawerPane[data-drawer="deuda"]');
  const accent = await debtPane.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      backgroundColor: s.backgroundColor,
      borderTopColor: s.borderTopColor,
      borderTopWidth: s.borderTopWidth,
    };
  });
  expect(accent).toEqual({
    backgroundColor: TRANSPARENT,
    borderTopColor: DEBIT_RULE,
    borderTopWidth: "4px",
  });
});
