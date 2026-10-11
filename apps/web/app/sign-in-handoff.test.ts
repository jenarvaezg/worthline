import { describe, expect, test } from "vitest";

import {
  handOffSignInWorkspace,
  takeSignInWorkspace,
  withSignInHandoff,
} from "./sign-in-handoff";

const WORKSPACE = { dbAuthToken: "token", dbUrl: "libsql://ws", id: "ws-ana" };

describe("sign-in handoff (#1175)", () => {
  test("the jwt callback receives what the signIn callback resolved, once", async () => {
    await withSignInHandoff(async () => {
      handOffSignInWorkspace("ana@example.com", WORKSPACE);
      // An await in between, as between Auth.js's two callbacks.
      await Promise.resolve();
      expect(takeSignInWorkspace("ana@example.com")).toEqual(WORKSPACE);
      expect(takeSignInWorkspace("ana@example.com")).toBeUndefined();
    });
  });

  test("is keyed by identity: another email takes nothing", async () => {
    await withSignInHandoff(async () => {
      handOffSignInWorkspace("ana@example.com", WORKSPACE);
      expect(takeSignInWorkspace("leo@example.com")).toBeUndefined();
    });
  });

  test("never crosses requests: each sign-in request has its own scope", async () => {
    let release = () => {};
    const bothInside = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withSignInHandoff(async () => {
      handOffSignInWorkspace("ana@example.com", WORKSPACE);
      await bothInside;
      return takeSignInWorkspace("ana@example.com");
    });
    const second = withSignInHandoff(async () => {
      release();
      return takeSignInWorkspace("ana@example.com");
    });

    expect(await second).toBeUndefined();
    expect(await first).toEqual(WORKSPACE);
  });

  test("outside a sign-in request there is nothing to hand off or take", () => {
    handOffSignInWorkspace("ana@example.com", WORKSPACE);
    expect(takeSignInWorkspace("ana@example.com")).toBeUndefined();
  });
});
