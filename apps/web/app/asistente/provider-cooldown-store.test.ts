import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProviderCooldownStoreTimeoutError,
  providerCooldownDeploymentKey,
  withProviderCooldownTimeout,
} from "./provider-cooldown-store";

afterEach(() => {
  vi.useRealTimers();
});

describe("providerCooldownDeploymentKey", () => {
  it("prefers an explicit stable key, then Vercel deployment identity", () => {
    expect(
      providerCooldownDeploymentKey({
        WORTHLINE_CHAT_DEPLOYMENT_KEY: "demo",
        VERCEL_URL: "preview.example",
      }),
    ).toBe("demo");
    expect(providerCooldownDeploymentKey({ VERCEL_URL: "preview.example" })).toBe(
      "preview.example",
    );
    expect(providerCooldownDeploymentKey({ VERCEL_ENV: "production" })).toBe(
      "production",
    );
  });

  it("refuses a global hosted bucket when no deployment identity exists", () => {
    expect(() => providerCooldownDeploymentKey({})).toThrow(
      /requires WORTHLINE_CHAT_DEPLOYMENT_KEY/i,
    );
  });
});

describe("withProviderCooldownTimeout", () => {
  it("rejects a controlled hung read within the bound", async () => {
    vi.useFakeTimers();
    const pending = withProviderCooldownTimeout(
      "read",
      new Promise<never>(() => undefined),
      25,
    );
    const rejection = expect(pending).rejects.toEqual(
      new ProviderCooldownStoreTimeoutError("read", 25),
    );

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it("clears the timeout after a controlled operation resolves", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const task = new Promise<string>((done) => {
      resolve = done;
    });
    const pending = withProviderCooldownTimeout("write", task, 25);

    resolve("stored");

    await expect(pending).resolves.toBe("stored");
    expect(vi.getTimerCount()).toBe(0);
  });
});
