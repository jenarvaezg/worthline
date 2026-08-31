import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const close = vi.fn();
  const createControlPlaneStore = vi.fn(async (_options?: unknown) => ({
    close,
    readWorkspaceEntitlement: vi.fn(),
  }));
  return { close, createControlPlaneStore };
});

vi.mock("@worthline/db", () => ({
  createControlPlaneStore: (options: unknown) => mocks.createControlPlaneStore(options),
}));

import {
  controlPlaneTargetFromEnv,
  openControlPlaneStore,
  requireControlPlaneTarget,
  withControlPlaneStore,
  withOptionalControlPlaneStore,
} from "./control-plane-store";

describe("controlPlaneTargetFromEnv (#1694)", () => {
  test("no URL is no target — the caller never opens anything", () => {
    expect(controlPlaneTargetFromEnv({})).toBeNull();
  });

  test("a blank URL is not a configured control plane", () => {
    expect(
      controlPlaneTargetFromEnv({ WORTHLINE_CONTROL_PLANE_DB_URL: "   " }),
    ).toBeNull();
  });

  test("omits authToken entirely when the env has none (never a bare undefined)", () => {
    expect(
      controlPlaneTargetFromEnv({ WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp" }),
    ).toEqual({ url: "libsql://cp" });
  });

  test("carries the group token when the env declares one", () => {
    expect(
      controlPlaneTargetFromEnv({
        WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
        WORTHLINE_DB_AUTH_TOKEN: "tok",
      }),
    ).toEqual({ url: "libsql://cp", authToken: "tok" });
  });

  test("a blank token is no token", () => {
    expect(
      controlPlaneTargetFromEnv({
        WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
        WORTHLINE_DB_AUTH_TOKEN: "  ",
      }),
    ).toEqual({ url: "libsql://cp" });
  });

  test("defaults to process.env", () => {
    process.env.WORTHLINE_CONTROL_PLANE_DB_URL = "libsql://from-process";
    expect(controlPlaneTargetFromEnv()).toEqual({ url: "libsql://from-process" });
  });
});

describe("requireControlPlaneTarget (#1694)", () => {
  test("names the caller's purpose in the error", () => {
    expect(() => requireControlPlaneTarget("Daily capture", {})).toThrow(
      "Daily capture requires WORTHLINE_CONTROL_PLANE_DB_URL.",
    );
  });
});

describe("withControlPlaneStore (#1694)", () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.createControlPlaneStore.mockClear();
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    delete process.env.WORTHLINE_DB_AUTH_TOKEN;
  });

  test("opens from the target, hands the store to run, and always closes", async () => {
    const result = await withControlPlaneStore(async () => "done", {
      env: {
        WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp",
        WORTHLINE_DB_AUTH_TOKEN: "t",
      },
    });

    expect(result).toBe("done");
    expect(mocks.createControlPlaneStore).toHaveBeenCalledWith({
      url: "libsql://cp",
      authToken: "t",
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  test("closes the store when run throws (the close no call-site can forget)", async () => {
    await expect(
      withControlPlaneStore(
        () => {
          throw new Error("boom");
        },
        { env: { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp" } },
      ),
    ).rejects.toThrow("boom");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  test("an injected store is the caller's to close, never the helper's", async () => {
    const injectedStore = { close: vi.fn() };
    await withControlPlaneStore((store) => store, { injectedStore });

    expect(mocks.createControlPlaneStore).not.toHaveBeenCalled();
    expect(injectedStore.close).not.toHaveBeenCalled();
  });

  test("a caller-supplied opener is used AND its store is closed here", async () => {
    const close = vi.fn();
    const open = vi.fn(async () => ({ close }));

    await withControlPlaneStore((store) => store, { open });

    expect(open).toHaveBeenCalledTimes(1);
    expect(mocks.createControlPlaneStore).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("throws (never opens) when no control plane is configured", async () => {
    await expect(
      withControlPlaneStore(async () => "unreachable", { env: {}, purpose: "The queue" }),
    ).rejects.toThrow("The queue requires WORTHLINE_CONTROL_PLANE_DB_URL.");
    expect(mocks.createControlPlaneStore).not.toHaveBeenCalled();
  });

  test("does not cache the connection across calls (one open per call)", async () => {
    const env = { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp" };
    await withControlPlaneStore(async () => 1, { env });
    await withControlPlaneStore(async () => 2, { env });

    expect(mocks.createControlPlaneStore).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});

describe("withOptionalControlPlaneStore (#1694)", () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.createControlPlaneStore.mockClear();
    delete process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
    delete process.env.WORTHLINE_DB_AUTH_TOKEN;
  });

  test("unconfigured resolves null WITHOUT opening a store", async () => {
    await expect(
      withOptionalControlPlaneStore(async () => "ran", { env: {} }),
    ).resolves.toBeNull();
    expect(mocks.createControlPlaneStore).not.toHaveBeenCalled();
  });

  test("configured runs and closes", async () => {
    await expect(
      withOptionalControlPlaneStore(async () => "ran", {
        env: { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp" },
      }),
    ).resolves.toBe("ran");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  test("an open failure propagates (the caller decides how to degrade)", async () => {
    mocks.createControlPlaneStore.mockRejectedValueOnce(new Error("cannot connect"));
    await expect(
      withOptionalControlPlaneStore(async () => "ran", {
        env: { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://cp" },
      }),
    ).rejects.toThrow("cannot connect");
    expect(mocks.close).not.toHaveBeenCalled();
  });
});

describe("openControlPlaneStore (#1694)", () => {
  beforeEach(() => {
    mocks.createControlPlaneStore.mockClear();
  });

  test("prefers an explicit target over the env", async () => {
    await openControlPlaneStore({
      target: { url: "libsql://explicit" },
      env: { WORTHLINE_CONTROL_PLANE_DB_URL: "libsql://ignored" },
    });
    expect(mocks.createControlPlaneStore).toHaveBeenCalledWith({
      url: "libsql://explicit",
    });
  });
});
