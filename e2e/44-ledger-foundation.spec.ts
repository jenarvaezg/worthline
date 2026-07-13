import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";

async function openResumen(page: Page, viewport: { height: number; width: number }) {
  await page.setViewportSize(viewport);
  await page.goto("/");
  await expect(page).toHaveURL(/\/app$/);

  const hero = page.getByRole("region", { name: "Resumen patrimonial" });
  const liquidity = page.getByRole("region", { name: "Liquidez por capa" });
  const history = page.getByRole("region", { name: "Evolución del patrimonio" });
  const fire = page.getByRole("region", { name: "FIRE" });
  await expect(hero).toBeVisible();
  await expect(liquidity).toBeVisible();
  await expect(history).toBeVisible();
  await expect(fire).toBeVisible();

  return { fire, hero, history, liquidity };
}

async function sectionStyle(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderTopStyle: style.borderTopStyle,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
    };
  });
}

test("Libro mayor foundation holds at 1440×1024", async ({ page }) => {
  const { fire, hero, history, liquidity } = await openResumen(page, {
    height: 1024,
    width: 1440,
  });

  expect(
    await page
      .locator("body")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgb(238, 240, 228)");

  expect(await sectionStyle(hero)).toMatchObject({
    backgroundColor: "rgb(247, 247, 238)",
    borderRadius: "6px",
    boxShadow: "none",
  });
  expect(
    await hero.evaluate((element) => getComputedStyle(element).backgroundImage),
  ).toContain("linear-gradient");

  for (const section of [liquidity, history, fire]) {
    expect(await sectionStyle(section)).toEqual({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderRadius: "0px",
      borderTopStyle: "solid",
      borderTopWidth: "2px",
      boxShadow: "none",
    });
  }

  const total = hero.locator(".headline > strong");
  const totalRule = await total.evaluate((element) => {
    const after = getComputedStyle(element, "::after");
    return { backgroundImage: after.backgroundImage, height: after.height };
  });
  expect(totalRule.height).toBe("4px");
  expect(totalRule.backgroundImage).toContain("linear-gradient");
  // The double-rule uses two ink stops, each with two positions
  // (`var(--ink) 0 1px` and `var(--ink) 3px 4px`); the browser expands every
  // double-position stop into two, so the ink colour resolves four times.
  expect(totalRule.backgroundImage.match(/rgb\(28, 36, 32\)/g)).toHaveLength(4);

  const framing = hero.getByRole("navigation", { name: "Vista de patrimonio" });
  expect(
    await framing.evaluate((element) => getComputedStyle(element).borderRadius),
  ).toBe("4px");

  const [heroBox, liquidityBox, historyBox, fireBox] = await Promise.all([
    hero.boundingBox(),
    liquidity.boundingBox(),
    history.boundingBox(),
    fire.boundingBox(),
  ]);
  expect(heroBox).not.toBeNull();
  expect(liquidityBox).not.toBeNull();
  expect(historyBox).not.toBeNull();
  expect(fireBox).not.toBeNull();
  expect(heroBox!.width / liquidityBox!.width).toBeGreaterThan(1.8);
  expect(Math.abs(heroBox!.width - historyBox!.width)).toBeLessThan(2);
  expect(Math.abs(liquidityBox!.width - fireBox!.width)).toBeLessThan(2);

  const headingFamily = await liquidity
    .getByRole("heading", { level: 2 })
    .evaluate((element) => getComputedStyle(element).fontFamily);
  const brandFamily = await page
    .getByRole("heading", { level: 1, name: "worthline" })
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(headingFamily).not.toBe(brandFamily);
});

test("Libro mayor foundation stacks without overflow at 390×844", async ({ page }) => {
  const { fire, hero, history, liquidity } = await openResumen(page, {
    height: 844,
    width: 390,
  });

  const boxes = await Promise.all(
    [hero, liquidity, history, fire].map((region) => region.boundingBox()),
  );
  for (const box of boxes) expect(box).not.toBeNull();
  for (const box of boxes.slice(1)) {
    expect(Math.abs(box!.x - boxes[0]!.x)).toBeLessThan(2);
    expect(Math.abs(box!.width - boxes[0]!.width)).toBeLessThan(2);
  }
  expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
  expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
  expect(boxes[2]!.y).toBeLessThan(boxes[3]!.y);

  expect(
    await hero.locator(".heroStats").evaluate((element) => {
      return getComputedStyle(element).gridTemplateColumns.split(" ").length;
    }),
  ).toBe(2);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);

  for (const section of [liquidity, history, fire]) {
    expect(await sectionStyle(section)).toMatchObject({
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderRadius: "0px",
      borderTopWidth: "2px",
      boxShadow: "none",
    });
  }
});
