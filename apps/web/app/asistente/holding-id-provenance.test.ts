import {
  createGroundedHoldingIds,
  groundedHoldingIdsInHistory,
  holdingReferencesIn,
  requiresGroundedHoldingIds,
  ungroundedHoldingIds,
  withHoldingIdProvenance,
} from "@web/asistente/holding-id-provenance";
import type { ToolSet, UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

const READ = "wl_hld_c5d97d4b4a1b9d7b42f2b7a976f0d14b";
const NEVER_READ = "wl_hld_3d4408012674258705c93c4e320f750d";
/** What the pool model actually sent to a write tool (#1263). */
const MONOLOGUE = "wl_hld_mortgage_id_placeholder_need_to_find_it";

describe("requiresGroundedHoldingIds", () => {
  it("covers every write path and leaves reads alone", () => {
    expect(requiresGroundedHoldingIds("propose_correction")).toBe(true);
    expect(requiresGroundedHoldingIds("propose_early_repayment")).toBe(true);
    // Filed against a holding in the control plane: an id that does not exist makes
    // the alert noise in the inbox that exists to catch calculation bugs (#1050).
    expect(requiresGroundedHoldingIds("raise_maintainer_alert")).toBe(true);
    expect(requiresGroundedHoldingIds("get_holding_detail")).toBe(false);
    expect(requiresGroundedHoldingIds("get_financial_context")).toBe(false);
    expect(requiresGroundedHoldingIds("suggest_actions")).toBe(false);
  });
});

describe("holdingReferencesIn", () => {
  it("reads the four reference fields, including nested segments", () => {
    expect(
      holdingReferencesIn({
        holdingId: READ,
        segments: [{ liabilityId: NEVER_READ }, { assetId: MONOLOGUE }],
      }),
    ).toEqual([READ, NEVER_READ, MONOLOGUE]);
  });

  it("reads a list of references", () => {
    expect(holdingReferencesIn({ holdingIds: [READ, NEVER_READ] })).toEqual([
      READ,
      NEVER_READ,
    ]);
  });

  it("ignores worthline's own draft handle", () => {
    // `proposalId` comes from a previous proposal, not from a read.
    expect(holdingReferencesIn({ proposalId: "prop_1", rawText: "x" })).toEqual([]);
  });

  it("ignores free text, so a pasted document is never a reference", () => {
    expect(
      holdingReferencesIn({ rawText: `saldo de ${NEVER_READ}`, summary: MONOLOGUE }),
    ).toEqual([]);
  });

  it("ignores blanks: a missing argument is a schema failure, not laundering", () => {
    expect(holdingReferencesIn({ holdingId: "   ", holdingIds: ["", READ] })).toEqual([
      READ,
    ]);
  });

  it("does not mistake an ordinary word ending in «id» for a reference", () => {
    expect(holdingReferencesIn({ valid: "no" })).toEqual([]);
  });
});

describe("createGroundedHoldingIds", () => {
  it("grounds what a read answered and nothing else", () => {
    const grounded = createGroundedHoldingIds();
    expect(grounded.has(READ)).toBe(false);
    grounded.record({ holdings: [{ id: READ, label: "Hipoteca" }] });
    expect(grounded.has(READ)).toBe(true);
    expect(grounded.has(NEVER_READ)).toBe(false);
  });

  it("starts from the ids the conversation already surfaced", () => {
    expect(createGroundedHoldingIds([READ]).has(READ)).toBe(true);
  });
});

describe("ungroundedHoldingIds", () => {
  it("reports the id no read ever surfaced", () => {
    const grounded = createGroundedHoldingIds([READ]);
    expect(ungroundedHoldingIds({ holdingId: READ }, grounded)).toEqual([]);
    expect(ungroundedHoldingIds({ holdingId: NEVER_READ }, grounded)).toEqual([
      NEVER_READ,
    ]);
  });

  it("reports the model's own monologue sitting in the id field (#1263)", () => {
    expect(
      ungroundedHoldingIds({ liabilityId: MONOLOGUE }, createGroundedHoldingIds()),
    ).toEqual([MONOLOGUE]);
  });

  it("reports a holding NAME passed where its id belongs", () => {
    expect(
      ungroundedHoldingIds(
        { holdingId: "Préstamos Revolut" },
        createGroundedHoldingIds(),
      ),
    ).toEqual(["Préstamos Revolut"]);
  });
});

describe("groundedHoldingIdsInHistory", () => {
  const messageWith = (parts: UIMessage["parts"]): UIMessage => ({
    id: "m1",
    parts,
    role: "assistant",
  });

  it("grounds ids from a read's output", () => {
    const messages = [
      messageWith([
        {
          type: "tool-get_financial_context",
          toolCallId: "c1",
          state: "output-available",
          input: {},
          output: { holdings: [{ id: READ, label: "Hipoteca" }] },
        } as unknown as UIMessage["parts"][number],
      ]),
    ];
    expect(groundedHoldingIdsInHistory(messages)).toEqual([READ]);
  });

  it("grounds a proposal's output: the server built it after the id resolved", () => {
    const messages = [
      messageWith([
        {
          type: "tool-propose_correction",
          toolCallId: "c2",
          state: "output-available",
          input: {},
          output: { proposalType: "correction", publicHoldingId: READ },
        } as unknown as UIMessage["parts"][number],
      ]),
    ];
    expect(groundedHoldingIdsInHistory(messages)).toEqual([READ]);
  });

  it("never grounds an id the model only wrote in prose", () => {
    const messages = [messageWith([{ type: "text", text: `el ID es ${NEVER_READ}` }])];
    expect(groundedHoldingIdsInHistory(messages)).toEqual([]);
  });

  it("never grounds an id the model only put in a tool INPUT", () => {
    const messages = [
      messageWith([
        {
          type: "tool-get_holding_detail",
          toolCallId: "c3",
          state: "input-available",
          input: { holdingId: NEVER_READ },
        } as unknown as UIMessage["parts"][number],
      ]),
    ];
    expect(groundedHoldingIdsInHistory(messages)).toEqual([]);
  });
});

describe("withHoldingIdProvenance", () => {
  const toolSetOver = (execute: (input: unknown) => unknown): ToolSet =>
    ({
      get_holding_detail: { execute },
      propose_correction: { execute },
      suggest_actions: {},
    }) as unknown as ToolSet;

  /** The SDK types `execute` against each tool's own input; a fixture is looser. */
  const call = (tools: ToolSet, name: string, input: unknown): Promise<unknown> =>
    Promise.resolve(
      tools[name]?.execute?.(
        input as never,
        {
          messages: [],
          toolCallId: "c1",
        } as never,
      ),
    );

  it("grounds the ids a read answered, so a later write in the same turn passes", async () => {
    const grounded = createGroundedHoldingIds();
    const guarded = withHoldingIdProvenance(
      toolSetOver(() => ({ id: READ, label: "Hipoteca" })),
      grounded,
    );

    await call(guarded, "get_holding_detail", { holdingId: READ });

    expect(grounded.has(READ)).toBe(true);
  });

  it("rejects a write pointing at an id no read surfaced, before the tool body runs", async () => {
    const execute = vi.fn(() => ({ proposalType: "correction" }));
    const guarded = withHoldingIdProvenance(
      toolSetOver(execute),
      createGroundedHoldingIds(),
    );

    const result = await call(guarded, "propose_correction", { holdingId: MONOLOGUE });

    expect(result).toMatchObject({
      error: "ungrounded_holding_id",
      ungroundedHoldingIds: [MONOLOGUE],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("lets the same write through once a read has grounded the id", async () => {
    const execute = vi.fn(() => ({ proposalType: "correction" }));
    const grounded = createGroundedHoldingIds();
    grounded.record({ id: READ, label: "Hipoteca" });
    const guarded = withHoldingIdProvenance(toolSetOver(execute), grounded);

    const result = await call(guarded, "propose_correction", { holdingId: READ });

    expect(result).toEqual({ proposalType: "correction" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("leaves reads untouched: an unknown id there answers not_found on its own", async () => {
    const execute = vi.fn(() => ({ error: { code: "not_found" } }));
    const guarded = withHoldingIdProvenance(
      toolSetOver(execute),
      createGroundedHoldingIds(),
    );

    await call(guarded, "get_holding_detail", { holdingId: NEVER_READ });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports the rejection so the route can count how often the model invents", async () => {
    const onRejected = vi.fn();
    const guarded = withHoldingIdProvenance(
      toolSetOver(() => ({})),
      createGroundedHoldingIds(),
      onRejected,
    );

    await call(guarded, "propose_correction", { holdingId: NEVER_READ });

    expect(onRejected).toHaveBeenCalledWith({
      tool: "propose_correction",
      ungroundedHoldingIds: [NEVER_READ],
    });
  });

  it("keeps a tool with no execute", () => {
    const guarded = withHoldingIdProvenance(
      toolSetOver(() => ({})),
      createGroundedHoldingIds(),
    );
    expect(guarded["suggest_actions"]).toBeDefined();
  });
});
