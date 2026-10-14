/**
 * The owner's sharing actions (#1844, S4 of #1718, ADR 0112): «Dar acceso» and
 * «Quitar acceso» on /ajustes. Exercised through the real FormData → terminal
 * interface against an in-memory control plane and the real S1 commands, so a
 * claim like «the share is made with the session's email» is observed in the
 * control plane, not in a mock's call log.
 *
 *  - the commands run with the SESSION's email as the owner: the workspace is
 *    never a form field, so a crafted POST can only share the poster's own;
 *  - every refusal comes back inline when the submit asked for it (the terminal
 *    that cannot be lost, interaction-patterns §4.1), and as a redirect to the
 *    form otherwise (no-JS);
 *  - a read-only target — the demo, an admin impersonating, a viewer — is stopped
 *    by the combinator's guard before the control plane is touched.
 */

import {
  DEMO_DISABLED_MESSAGE,
  IMPERSONATION_READONLY_MESSAGE,
  VIEWER_READONLY_MESSAGE,
} from "@web/demo/write-guard";
import type { StoreTarget } from "@web/store-resolver";
import {
  type AdminControlPlaneStore,
  createInMemoryControlPlaneStore,
  createInMemoryStore,
  type TursoPort,
} from "@worthline/db";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { revokeReadOnlyAccessAction, shareReadOnlyAccessAction } from "./sharing-actions";

const OWNER: StoreTarget = {
  dbUrl: "libsql://wl-jose.turso.io",
  kind: "authenticated",
  token: "full-jose",
  workspaceId: "ws_jose",
};

let mockTarget: StoreTarget = OWNER;
let mockSessionEmail: string | null = "jose@example.com";
vi.mock("@web/read-store-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@web/read-store-target")>()),
  readSessionEmail: async () => mockSessionEmail,
  readStoreTarget: async () => mockTarget,
}));

/** A Turso port that only mints read-only tokens, or fails when told to. */
function fakeTurso(fail = false): Pick<TursoPort, "createDatabaseToken"> {
  return {
    async createDatabaseToken(name, authorization) {
      if (fail) throw new Error("Turso is down");
      return { jwt: `${authorization}-${name}` };
    },
  };
}

let controlPlane: AdminControlPlaneStore;
let workspaceId: string;

beforeEach(async () => {
  controlPlane = await createInMemoryControlPlaneStore();
  const jose = await controlPlane.findOrCreateUser("jose@example.com");
  const workspace = await controlPlane.createWorkspace({
    dbAuthToken: "full-jose",
    dbName: "wl-jose",
    dbUrl: "libsql://wl-jose.turso.io",
  });
  await controlPlane.recordGrant(jose.id, workspace.id);
  workspaceId = workspace.id;
});

afterEach(() => {
  controlPlane.close();
  mockTarget = OWNER;
  mockSessionEmail = "jose@example.com";
  vi.restoreAllMocks();
});

function shareForm(email: string, inline = true): FormData {
  const formData = new FormData();
  formData.set("currentUrl", "/ajustes");
  formData.set("viewerEmail", email);
  if (inline) formData.set("inlineError", "1");
  return formData;
}

function revokeForm(viewerUserId: string): FormData {
  const formData = new FormData();
  formData.set("currentUrl", "/ajustes");
  formData.set("viewerUserId", viewerUserId);
  formData.set("inlineError", "1");
  return formData;
}

/**
 * Run an action, returning its state — or, when it redirected, the path and the
 * decoded query of the URL it named (`NEXT_REDIRECT;<type>;<url>;<status>;`).
 */
async function settle(run: Promise<unknown>): Promise<unknown> {
  try {
    return await run;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      const url = new URL(digest.split(";")[2] ?? "", "http://localhost");
      return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
    }
    throw error;
  }
}

async function share(email: string, options: { inline?: boolean; fail?: boolean } = {}) {
  return settle(
    shareReadOnlyAccessAction(
      shareForm(email, options.inline ?? true),
      await createInMemoryStore(),
      {
        sharingPorts: { controlPlane, turso: fakeTurso(options.fail) },
      },
    ),
  );
}

async function viewerEmails(): Promise<string[]> {
  return (await controlPlane.listViewersOfWorkspace(workspaceId)).map((v) => v.email);
}

describe("«Dar acceso» (#1844)", () => {
  test("shares the SESSION's own workspace with the typed address, and lands on /ajustes", async () => {
    const result = await share("  Ana@Example.com ");

    expect(result).toEqual({
      path: "/ajustes",
      query: { ok: "read_only_access_granted" },
    });
    expect(await viewerEmails()).toEqual(["ana@example.com"]);
  });

  test("another session's email shares THAT session's workspace — never one named by the form", async () => {
    const eva = await controlPlane.findOrCreateUser("eva@example.com");
    const evas = await controlPlane.createWorkspace({
      dbAuthToken: "full-eva",
      dbName: "wl-eva",
      dbUrl: "libsql://wl-eva.turso.io",
    });
    await controlPlane.recordGrant(eva.id, evas.id);
    mockSessionEmail = "eva@example.com";

    const formData = shareForm("ana@example.com");
    formData.set("workspaceId", workspaceId);
    await settle(
      shareReadOnlyAccessAction(formData, await createInMemoryStore(), {
        sharingPorts: { controlPlane, turso: fakeTurso() },
      }),
    );

    expect(await viewerEmails()).toEqual([]);
    expect(
      (await controlPlane.listViewersOfWorkspace(evas.id)).map((v) => v.email),
    ).toEqual(["ana@example.com"]);
  });

  test.each([
    ["not an email", "ana@", "Escribe un email válido, como nombre@ejemplo.com."],
    ["oneself", "JOSE@example.com", "Ese es tu propio email: tu espacio ya lo ves tú."],
  ])("refuses %s inline, writing nothing", async (_label, email, message) => {
    expect(await share(email)).toEqual({
      error: message,
      ok: false,
      values: { viewerEmail: email },
    });
    expect(await viewerEmails()).toEqual([]);
  });

  test("refuses someone who already has access", async () => {
    await share("ana@example.com");

    expect(await share("ana@example.com")).toEqual({
      error: "Esa persona ya tiene acceso.",
      ok: false,
      values: { viewerEmail: "ana@example.com" },
    });
  });

  test("refuses a grant of another kind honestly — never as «ya tiene acceso» (#1718)", async () => {
    const conflicting = {
      ...controlPlane,
      recordViewerGrant: async () => "conflicting-grant" as const,
    };

    expect(
      await settle(
        shareReadOnlyAccessAction(
          shareForm("legacy@example.com"),
          await createInMemoryStore(),
          {
            sharingPorts: { controlPlane: conflicting, turso: fakeTurso() },
          },
        ),
      ),
    ).toEqual({
      error:
        "Esa persona tiene otro tipo de acceso a tu espacio, y desde aquí no se puede convertir en solo lectura.",
      ok: false,
      values: { viewerEmail: "legacy@example.com" },
    });
    expect(await viewerEmails()).toEqual([]);
  });

  test("refuses a sixth viewer", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) await share(`${name}@example.com`);

    expect(await share("f@example.com")).toMatchObject({
      error:
        "Ya hay 5 personas con acceso, el máximo. Quita a alguien antes de dar acceso a otra.",
      ok: false,
    });
    expect(await viewerEmails()).toHaveLength(5);
  });

  test("a failure to create the access reads as such, and leaves no grant", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await share("ana@example.com", { fail: true })).toMatchObject({
      error: "No se pudo dar el acceso. Inténtalo de nuevo en un momento.",
      ok: false,
    });
    expect(await viewerEmails()).toEqual([]);
  });

  test("without JavaScript a refusal redirects back to the form with what was typed", async () => {
    expect(await share("ana@", { inline: false })).toEqual({
      path: "/ajustes",
      query: {
        error: "Escribe un email válido, como nombre@ejemplo.com.",
        form: "readOnlyAccess",
        v_viewerEmail: "ana@",
      },
    });
  });

  test("a session that does not act on its own account cannot share (local, no session)", async () => {
    mockTarget = { kind: "local" };

    expect(await share("ana@example.com")).toMatchObject({ ok: false });
    expect(await viewerEmails()).toEqual([]);
  });
});

describe("«Quitar acceso» (#1844)", () => {
  test("takes a viewer's access back from the SESSION's own workspace", async () => {
    await share("ana@example.com");
    const [ana] = await controlPlane.listViewersOfWorkspace(workspaceId);

    const result = await settle(
      revokeReadOnlyAccessAction(
        revokeForm(ana?.userId ?? ""),
        await createInMemoryStore(),
        {
          sharingPorts: { controlPlane, turso: fakeTurso() },
        },
      ),
    );

    expect(result).toEqual({
      path: "/ajustes",
      query: { ok: "read_only_access_revoked" },
    });
    expect(await viewerEmails()).toEqual([]);
  });
});

describe("a read-only session cannot share or revoke (#1844)", () => {
  const readOnlyTargets: Array<[string, StoreTarget, string]> = [
    ["the demo", { kind: "demo", now: "", persona: "familia" }, DEMO_DISABLED_MESSAGE],
    [
      "an admin impersonating",
      { ...OWNER, impersonatedEmail: "jose@example.com" },
      IMPERSONATION_READONLY_MESSAGE,
    ],
    [
      "a viewer",
      { ...OWNER, sharedByEmail: "jose@example.com", token: "read-only" },
      VIEWER_READONLY_MESSAGE,
    ],
  ];

  test.each(
    readOnlyTargets,
  )("%s is turned back before the control plane", async (_label, target, message) => {
    mockTarget = target;

    expect(await share("ana@example.com")).toEqual({
      path: "/ajustes",
      query: { error: message },
    });
    expect(await viewerEmails()).toEqual([]);

    await controlPlane.recordViewerGrant(
      (await controlPlane.findOrCreateUser("leo@example.com")).id,
      workspaceId,
      5,
    );
    const [leo] = await controlPlane.listViewersOfWorkspace(workspaceId);
    const revoked = await settle(
      revokeReadOnlyAccessAction(
        revokeForm(leo?.userId ?? ""),
        await createInMemoryStore(),
        {
          sharingPorts: { controlPlane, turso: fakeTurso() },
        },
      ),
    );
    expect(revoked).toEqual({ path: "/ajustes", query: { error: message } });
    expect(await viewerEmails()).toEqual(["leo@example.com"]);
  });
});
