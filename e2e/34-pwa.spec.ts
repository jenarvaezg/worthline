import { test, expect } from "@playwright/test";

test.describe("PWA: manifest & service worker", () => {
  test("Slice 1: manifest is served and has PWA fields", async ({ request }) => {
    const response = await request.get("/manifest.json");
    expect(response.status()).toBe(200);

    const manifest = await response.json();
    expect(manifest.name).toBe("worthline");
    expect(manifest.short_name).toBe("worthline");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe("#006f5f"); // --green token
    expect(manifest.background_color).toBe("#eef2ef"); // --paper token
  });

  test("Slice 2a: sw.js is served", async ({ request }) => {
    const response = await request.get("/sw.js");
    expect(response.status()).toBe(200);
  });

  test("Slice 2b: service worker is registered in browser", async ({ page }) => {
    await page.goto("/");

    // Wait for service worker to register and be active
    const isRegistered = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      // We wait up to 5 seconds for service worker registration to complete
      for (let i = 0; i < 50; i++) {
        const regs = await navigator.serviceWorker.getRegistrations();
        if (regs.some((r) => r.active && r.active.scriptURL.endsWith("/sw.js"))) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    });

    expect(isRegistered).toBe(true);
  });

  test("Slice 3: static assets are cached, dynamic documents are network-first", async ({
    page,
    context,
  }) => {
    // 1. Visit the site normally to ensure Service Worker is active and controlling the client.
    await page.goto("/empezar");

    // Wait for the Service Worker to register and become active.
    await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return;
      const regs = await navigator.serviceWorker.getRegistrations();
      const activeReg = regs.find(
        (r) => r.active && r.active.scriptURL.endsWith("/sw.js"),
      );
      if (activeReg && activeReg.active) {
        if (activeReg.active.state !== "activated") {
          await new Promise<void>((resolve) => {
            activeReg.active!.addEventListener("statechange", () => {
              if (activeReg.active!.state === "activated") resolve();
            });
          });
        }
      }
    });

    // 2. Reload the page so the active service worker takes control of the page fetches.
    await page.reload();

    // 3. Go offline
    await context.setOffline(true);

    // 4. Try fetching a cached static asset (e.g. /manifest.json)
    // It should succeed (status 200) because it's served from cache by the SW.
    const manifestResponse = await page.evaluate(async () => {
      try {
        const res = await fetch("/manifest.json");
        return { status: res.status, ok: res.ok };
      } catch (err) {
        return { status: 0, ok: false, error: String(err) };
      }
    });
    expect(manifestResponse.status).toBe(200);

    // 5. Try fetching a page document (e.g. /empezar)
    // It should NOT load the live page (since we are offline and it's network-first).
    // It must either fail (status 0) or return our custom offline page.
    const docResponse = await page.evaluate(async () => {
      try {
        const res = await fetch("/empezar", { headers: { Accept: "text/html" } });
        const text = await res.text();
        return {
          status: res.status,
          ok: res.ok,
          isOfflinePage: text.includes("Sin conexión"),
        };
      } catch (err) {
        return { status: 0, ok: false, error: String(err), isOfflinePage: false };
      }
    });

    if (docResponse.ok) {
      expect(docResponse.isOfflinePage).toBe(true);
    } else {
      expect(docResponse.status).toBe(0);
    }

    // Clean up: restore network
    await context.setOffline(false);
  });
});
