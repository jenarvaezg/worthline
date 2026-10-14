/**
 * Signing out ends the viewer session too (#1843): `wl_viewing` and the member
 * scope are cleared with the Auth.js session, so the next account to sign in on
 * this browser starts in its own workspace instead of a viewer mode it never
 * chose. (The cookie would grant that account nothing without its own grant —
 * this is about not surprising it.)
 */

import { SCOPE_COOKIE_NAME } from "@web/intake";
import { VIEWING_COOKIE_NAME } from "@web/viewing/viewing-cookie";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("@web/read-store-target", () => ({
  readStoreTarget: async () => ({
    kind: "authenticated",
    workspaceId: "ws-lucia",
    dbUrl: "libsql://wl-lucia.turso.io",
    token: "full-lucia",
  }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    delete: (name: string) => {
      calls.order.push(`delete ${name}`);
    },
  }),
}));
vi.mock("@web/auth", () => ({
  signOut: async ({ redirectTo }: { redirectTo: string }) => {
    calls.order.push(`signOut ${redirectTo}`);
  },
}));

import SignOutButton from "./sign-out-button";

describe("SignOutButton (#1843)", () => {
  test("clears the viewer and scope cookies, then ends the session", async () => {
    const form = (await SignOutButton()) as ReactElement<{ action: () => Promise<void> }>;

    await form.props.action();

    expect(calls.order).toEqual([
      `delete ${VIEWING_COOKIE_NAME}`,
      `delete ${SCOPE_COOKIE_NAME}`,
      "signOut /",
    ]);
  });
});
