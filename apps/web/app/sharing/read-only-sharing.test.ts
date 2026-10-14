import {
  MAX_VIEWER_EMAIL_LENGTH,
  MAX_VIEWERS_PER_WORKSPACE,
  VIEWER_EMAIL_SHAPE,
} from "@worthline/db";
import { describe, expect, test } from "vitest";

import {
  applyViewerMutation,
  EMAIL_SHAPE,
  MAX_EMAIL_LENGTH,
  MAX_VIEWERS,
  planShare,
  SHARE_FAILURE_MESSAGE,
  type SharingActionResult,
  shareRefusalMessage,
  submitRevoke,
  submitShare,
  type ViewerMutation,
  type ViewerRow,
  viewerRowsFrom,
  viewerSinceLabel,
} from "./read-only-sharing";

/**
 * A recorder for one island's side of a submit: the optimistic rows it showed,
 * the refusals and draft it set, and every body the action received. The
 * transition runs its scope straight away, the way React starts it.
 */
function island(rows: ViewerRow[] = []) {
  const shown: ViewerMutation[] = [];
  const refusals: Array<string | null> = [];
  const drafts: string[] = [];
  const sent: FormData[] = [];
  const pending: Array<Promise<void>> = [];
  let answer: SharingActionResult = { ok: true };
  return {
    drafts,
    pending,
    refusals,
    sent,
    shown,
    answerWith(result: SharingActionResult) {
      answer = result;
    },
    deps: {
      action: async (formData: FormData) => {
        sent.push(formData);
        return answer;
      },
      onRefusal: (message: string | null) => refusals.push(message),
      rows: () => rows,
      showOptimistic: (mutation: ViewerMutation) => shown.push(mutation),
      startTransition: (scope: () => Promise<void>) => {
        pending.push(scope());
      },
    },
  };
}

function shareBody(email: string): FormData {
  const formData = new FormData();
  formData.set("viewerEmail", email);
  return formData;
}

describe("submitting a share (#1844)", () => {
  test("a refusal the client can see is said at once, and nothing is sent", () => {
    const it = island();

    submitShare({
      ...it.deps,
      formData: shareBody("ana@"),
      ownerEmail: "jose@example.com",
      setDraft: (d) => it.drafts.push(d),
      today: "2026-10-14",
    });

    expect(it.refusals).toEqual(["Escribe un email válido, como nombre@ejemplo.com."]);
    expect(it.sent).toEqual([]);
    expect(it.shown).toEqual([]);
  });

  test("a valid share shows the row, clears the field and sends with inlineError stamped", async () => {
    const it = island();

    submitShare({
      ...it.deps,
      formData: shareBody("Ana@Example.com"),
      ownerEmail: "jose@example.com",
      setDraft: (d) => it.drafts.push(d),
      today: "2026-10-14",
    });
    await Promise.all(it.pending);

    expect(it.shown).toEqual([
      { email: "ana@example.com", kind: "add", since: "2026-10-14" },
    ]);
    expect(it.drafts).toEqual([""]);
    expect(it.sent[0]?.get("inlineError")).toBe("1");
  });

  test("a refusal from the server is shown and what was typed comes back", async () => {
    const it = island();
    it.answerWith({ error: "Esa persona ya tiene acceso.", ok: false });

    submitShare({
      ...it.deps,
      formData: shareBody("ana@example.com"),
      ownerEmail: "jose@example.com",
      setDraft: (d) => it.drafts.push(d),
      today: "2026-10-14",
    });
    await Promise.all(it.pending);

    expect(it.refusals).toEqual([null, "Esa persona ya tiene acceso."]);
    expect(it.drafts).toEqual(["", "ana@example.com"]);
  });

  test("a second share while the first is in flight is sent too — never dropped in silence", async () => {
    const it = island();
    const submit = (email: string) =>
      submitShare({
        ...it.deps,
        formData: shareBody(email),
        ownerEmail: "jose@example.com",
        setDraft: (d) => it.drafts.push(d),
        today: "2026-10-14",
      });

    submit("ana@example.com");
    submit("eva@example.com");
    await Promise.all(it.pending);

    expect(it.sent.map((body) => body.get("viewerEmail"))).toEqual([
      "ana@example.com",
      "eva@example.com",
    ]);
  });
});

describe("submitting a revoke (#1844)", () => {
  test("removes the row at once and sends with inlineError stamped", async () => {
    const it = island();
    const formData = new FormData();
    formData.set("viewerUserId", "u_ana");

    submitRevoke({ ...it.deps, formData, userId: "u_ana" });
    await Promise.all(it.pending);

    expect(it.shown).toEqual([{ kind: "remove", userId: "u_ana" }]);
    expect(it.sent[0]?.get("inlineError")).toBe("1");
  });

  test("a second revoke while the first is in flight is sent too", async () => {
    const it = island();

    submitRevoke({ ...it.deps, formData: new FormData(), userId: "u_ana" });
    submitRevoke({ ...it.deps, formData: new FormData(), userId: "u_luis" });
    await Promise.all(it.pending);

    expect(it.shown).toEqual([
      { kind: "remove", userId: "u_ana" },
      { kind: "remove", userId: "u_luis" },
    ]);
    expect(it.sent).toHaveLength(2);
  });

  test("a refusal from the server is shown", async () => {
    const it = island();
    it.answerWith({ error: "No se pudo quitar el acceso.", ok: false });

    submitRevoke({ ...it.deps, formData: new FormData(), userId: "u_ana" });
    await Promise.all(it.pending);

    expect(it.refusals).toEqual([null, "No se pudo quitar el acceso."]);
  });
});

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

describe("the client's copy of the door's rules (#1718)", () => {
  // Copied because the client island cannot load `@worthline/db`'s runtime; if
  // the door's rules move, the copy must move with them or the section would
  // promise a share the server refuses (or refuse one it would accept).
  test("the cap, the email shape and its length are the door's own", () => {
    expect(MAX_VIEWERS).toBe(MAX_VIEWERS_PER_WORKSPACE);
    expect(EMAIL_SHAPE.source).toBe(VIEWER_EMAIL_SHAPE.source);
    expect(EMAIL_SHAPE.flags).toBe(VIEWER_EMAIL_SHAPE.flags);
    expect(MAX_EMAIL_LENGTH).toBe(MAX_VIEWER_EMAIL_LENGTH);
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
    expect(shareRefusalMessage("already-viewer")).toBe("Esa persona ya tiene acceso.");
    expect(shareRefusalMessage("viewer-limit")).toBe(
      "Ya hay 5 personas con acceso, el máximo. Quita a alguien antes de dar acceso a otra.",
    );
  });

  test("a grant of another kind is not «ya tiene acceso»: it says what it is (#1718)", () => {
    expect(shareRefusalMessage("conflicting-grant")).toBe(
      "Esa persona tiene otro tipo de acceso a tu espacio, y desde aquí no se puede convertir en solo lectura.",
    );
    expect(shareRefusalMessage("conflicting-grant")).not.toBe(
      shareRefusalMessage("already-viewer"),
    );
  });

  test("owning no workspace is not the person's fault: it reads as the failure", () => {
    expect(shareRefusalMessage("no-owned-workspace")).toBe(SHARE_FAILURE_MESSAGE);
    expect(SHARE_FAILURE_MESSAGE).toBe(
      "No se pudo dar el acceso. Inténtalo de nuevo en un momento.",
    );
  });
});
