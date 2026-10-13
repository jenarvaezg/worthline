import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";

async function openResumen(page: Page, viewport: { height: number; width: number }) {
  await page.setViewportSize(viewport);
  await page.goto("/app");
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

// #1723: the section strip scrolls with its bar hidden, so the edge that hides
// something fades (`data-more`) and nothing is cut in repose at 390 px. The
// suite runs without a session, so «Cerrar sesión» is not in the strip here.
function sectionStrip(page: Page) {
  const strip = page.locator(".topbarEnd");
  const tabs = strip
    .getByRole("navigation", { name: "Secciones principales" })
    .getByRole("link");
  return { strip, tabs };
}

test("the five section tabs fit the strip at 390×844 (#1723)", async ({ page }) => {
  await openResumen(page, { height: 844, width: 390 });
  const { strip, tabs } = sectionStrip(page);

  await expect(tabs).toHaveCount(5);
  const stripBox = await strip.boundingBox();
  expect(stripBox).not.toBeNull();
  for (const tab of await tabs.all()) {
    const box = await tab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(stripBox!.x - 0.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(stripBox!.x + stripBox!.width + 0.5);
  }

  await expect(strip).not.toHaveAttribute("data-more");
  expect(await strip.evaluate((element) => getComputedStyle(element).boxShadow)).toBe(
    "none",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test("the strip fades the edge that hides tabs at 360 px (#1723)", async ({ page }) => {
  await openResumen(page, { height: 800, width: 360 });
  const { strip } = sectionStrip(page);

  await expect(strip).toHaveAttribute("data-more", "end");
  expect(
    await strip.evaluate((element) => getComputedStyle(element).maskImage),
  ).toContain("linear-gradient");

  await strip.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(strip).toHaveAttribute("data-more", "start");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test("the topbar stacks in two rows up to 900 px and the strip fits (#1723)", async ({
  page,
}) => {
  await openResumen(page, { height: 1024, width: 768 });
  const { strip } = sectionStrip(page);
  const brand = page.locator(".topbar > .brand");

  const [brandBox, stripBox] = await Promise.all([
    brand.boundingBox(),
    strip.boundingBox(),
  ]);
  expect(brandBox).not.toBeNull();
  expect(stripBox).not.toBeNull();
  expect(stripBox!.y).toBeGreaterThanOrEqual(brandBox!.y + brandBox!.height);
  expect(
    await strip.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(strip).not.toHaveAttribute("data-more");

  await page.setViewportSize({ height: 1024, width: 901 });
  const [oneRowBrand, oneRowStrip] = await Promise.all([
    brand.boundingBox(),
    strip.boundingBox(),
  ]);
  expect(oneRowStrip!.y).toBeLessThan(oneRowBrand!.y + oneRowBrand!.height);
});
