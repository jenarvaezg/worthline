import { describe, expect, test } from "vitest";

import {
  applyViewerMutation,
  planShare,
  SHARE_FAILURE_MESSAGE,
  shareRefusalMessage,
  viewerRowsFrom,
  viewerSinceLabel,
} from "./read-only-sharing";

const ANA = {
  createdAt: "2026-10-01 09:30:00",
  email: "ana@example.com",
  userId: "u_ana",
};
const LUIS = {
  createdAt: "2026-10-03 18:00:00",
  email: "luis@example.com",
  userId: "u_luis",
};

describe("the owner's viewer list, folded with pending mutations (#1844)", () => {
  test("the server's viewers become rows that can be taken back", () => {
    expect(viewerRowsFrom([ANA])).toEqual([
      { email: "ana@example.com", since: "2026-10-01", userId: "u_ana" },
    ]);
  });

  test("giving access adds a pending row — no user id yet, so nothing to take back", () => {
    const rows = applyViewerMutation(viewerRowsFrom([ANA]), {
      email: "eva@example.com",
      kind: "add",
      since: "2026-10-14",
    });
    expect(rows).toEqual([
      { email: "ana@example.com", since: "2026-10-01", userId: "u_ana" },
      { email: "eva@example.com", since: "2026-10-14", userId: null },
    ]);
  });

  test("taking access back removes exactly that viewer", () => {
    const rows = applyViewerMutation(viewerRowsFrom([ANA, LUIS]), {
      kind: "remove",
      userId: "u_ana",
    });
    expect(rows.map((row) => row.email)).toEqual(["luis@example.com"]);
  });

  test("the date reads as a calendar day, whatever the stored time of day", () => {
    expect(viewerSinceLabel("2026-10-01")).toBe("desde el 01/10/2026");
  });
});

describe("planning a share before the round trip (#1844)", () => {
  const base = { ownerEmail: "jose@example.com", viewers: viewerRowsFrom([ANA]) };

  test("a valid new address is shown at once, trimmed and lower-cased", () => {
    expect(planShare({ ...base, email: "  Eva@Example.com " })).toEqual({
      email: "eva@example.com",
      kind: "optimistic",
    });
  });

  test("an address that is not an email is refused on the spot", () => {
    expect(planShare({ ...base, email: "eva@" })).toEqual({
      error: "Escribe un email válido, como nombre@ejemplo.com.",
      kind: "reject",
    });
  });

  test("the owner's own address is refused on the spot", () => {
    expect(planShare({ ...base, email: "JOSE@example.com" })).toEqual({
      error: "Ese es tu propio email: tu espacio ya lo ves tú.",
      kind: "reject",
    });
  });

  test("someone already on the list is refused on the spot", () => {
    expect(planShare({ ...base, email: "ana@EXAMPLE.com" })).toEqual({
      error: "Esa persona ya tiene acceso.",
      kind: "reject",
    });
  });

  test("a sixth viewer is refused on the spot", () => {
    const viewers = ["a", "b", "c", "d", "e"].map((name) => ({
      email: `${name}@example.com`,
      since: "2026-10-01",
      userId: `u_${name}`,
    }));
    expect(planShare({ ...base, email: "f@example.com", viewers })).toEqual({
      error:
        "Ya hay 5 personas con acceso, el máximo. Quita a alguien antes de dar acceso a otra.",
      kind: "reject",
    });
  });
});

describe("every refusal of the sharing door reads as Spanish (#1844)", () => {
  test("each typed refusal has its own message", () => {
    expect(shareRefusalMessage("invalid-email")).toBe(
      "Escribe un email válido, como nombre@ejemplo.com.",
    );
    expect(shareRefusalMessage("self-share")).toBe(
      "Ese es tu propio email: tu espacio ya lo ves tú.",
    );
    expect(shareRefusalMessage("already-granted")).toBe("Esa persona ya tiene acceso.");
    expect(shareRefusalMessage("viewer-limit")).toBe(
      "Ya hay 5 personas con acceso, el máximo. Quita a alguien antes de dar acceso a otra.",
    );
  });

  test("owning no workspace is not the person's fault: it reads as the failure", () => {
    expect(shareRefusalMessage("no-owned-workspace")).toBe(SHARE_FAILURE_MESSAGE);
    expect(SHARE_FAILURE_MESSAGE).toBe(
      "No se pudo dar el acceso. Inténtalo de nuevo en un momento.",
    );
  });
});
