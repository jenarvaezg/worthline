import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  correctFabricatedMaintainerAlertClaims,
  correctFabricatedProposalClaims,
  DROPPED_TOOL_PAYLOAD_NOTE,
  dropStaleToolPayloads,
  INTERRUPTED_PROPOSAL_NOTE,
  pruneOrphanToolCalls,
  withoutToolParts,
} from "./chat-history";
import { FABRICATED_ALERT_MODEL_NOTE } from "./fabricated-maintainer-alert";
import { FABRICATED_PROPOSAL_MODEL_NOTE } from "./fabricated-proposal";
import {
  correctionProposalOutput,
  inFlightAlertPart,
  raisedAlertPart,
  refusedAlertPart,
} from "./proposal-part-fixtures";

function assistant(id: string, ...parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage;
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

function toolCall(state: string, toolCallId: string, output?: unknown) {
  return {
    type: "tool-get_financial_context",
    toolCallId,
    state,
    input: {},
    ...(output === undefined ? {} : { output }),
  };
}

const BUDGET = {
  maxParts: 40,
  proposalChars: 48_000,
  staleChars: 24_000,
  totalChars: 80_000,
};

describe("pruneOrphanToolCalls", () => {
  it("drops a call whose result never arrived and keeps the prose beside it", () => {
    const history = [
      user("u1", "¿cuánto tengo?"),
      assistant(
        "a1",
        { type: "text", text: "Voy a mirarlo" },
        toolCall("input-available", "c1"),
      ),
      user("u2", "reintento"),
    ];

    const { messages, orphanToolCallIds } = pruneOrphanToolCalls(history);

    expect(orphanToolCallIds).toEqual(["c1"]);
    expect(messages[1]?.parts).toEqual([{ type: "text", text: "Voy a mirarlo" }]);
    expect(messages).toHaveLength(3);
  });

  it("drops the message entirely when the orphan read was all it carried", () => {
    const history = [
      user("u1", "¿cuánto tengo?"),
      assistant("a1", toolCall("input-streaming", "c1")),
      user("u2", "reintento"),
    ];

    const { messages } = pruneOrphanToolCalls(history);

    expect(messages.map((message) => message.id)).toEqual(["u1", "u2"]);
  });

  it("prunes the approval states too — no chat tool asks for approval", () => {
    // A part in one of these states reaches the prompt as a call with no result,
    // so a client that invents one would poison the conversation exactly like a
    // dead stream does.
    for (const state of ["approval-requested", "approval-responded"]) {
      const history = [
        assistant("a1", { type: "text", text: "hola" }, toolCall(state, "c1")),
        user("u1", "sigue"),
      ];

      expect(pruneOrphanToolCalls(history).orphanToolCallIds).toEqual(["c1"]);
    }
  });

  it("says so when the interrupted call was a PROPOSAL", () => {
    // Otherwise the surviving prose («te preparo la propuesta») stands as a
    // promise the app never kept, and the model may claim it exists.
    const history = [
      assistant(
        "a1",
        { type: "text", text: "Te preparo la propuesta" },
        {
          type: "tool-propose_correction",
          toolCallId: "c1",
          state: "input-available",
          input: {},
        },
      ),
      user("u1", "sí, hazlo"),
    ];

    const { messages } = pruneOrphanToolCalls(history);

    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "Te preparo la propuesta" },
      { type: "text", text: INTERRUPTED_PROPOSAL_NOTE },
    ]);
  });

  it("leaves a healthy history untouched, by identity", () => {
    const history = [
      user("u1", "¿cuánto tengo?"),
      assistant("a1", toolCall("output-available", "c1", { netWorthMinor: 1 })),
      user("u2", "¿y el mes pasado?"),
    ];

    const { messages, orphanToolCallIds } = pruneOrphanToolCalls(history);

    expect(orphanToolCallIds).toEqual([]);
    // Same array, not a copy: a healthy conversation pays nothing for this.
    expect(messages).toBe(history);
  });

  it("keeps the states that do carry a result", () => {
    const history = [
      assistant(
        "a1",
        toolCall("output-available", "c1", { ok: true }),
        toolCall("output-error", "c2"),
        toolCall("output-denied", "c3"),
      ),
      user("u1", "sigue"),
    ];

    expect(pruneOrphanToolCalls(history).orphanToolCallIds).toEqual([]);
  });

  it("never mutates the history it was given", () => {
    const part = toolCall("input-available", "c1");
    const history = [
      assistant("a1", { type: "text", text: "hola" }, part),
      user("u1", "x"),
    ];
    const before = JSON.parse(JSON.stringify(history));

    pruneOrphanToolCalls(history);

    expect(history).toEqual(before);
  });
});

describe("dropStaleToolPayloads", () => {
  const reading = (marker: string, chars: number) => ({
    marker,
    relleno: "x".repeat(chars),
  });

  it("drops the older readings and keeps the freshest one verbatim", () => {
    const history = [
      assistant("a1", toolCall("output-available", "c1", reading("VIEJA", 200))),
      user("u1", "sigue"),
      assistant("a2", toolCall("output-available", "c2", reading("FRESCA", 200))),
      user("u2", "y más"),
    ];

    const { messages, droppedToolCallIds } = dropStaleToolPayloads(history, {
      maxParts: 40,
      proposalChars: 1_000,
      staleChars: 100,
      totalChars: 400,
    });

    expect(droppedToolCallIds).toEqual(["c1"]);
    // The old part is gone — not swapped — and a single note takes its place.
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: DROPPED_TOOL_PAYLOAD_NOTE },
    ]);
    expect(messages[2]?.parts[0]).toEqual(
      expect.objectContaining({ output: reading("FRESCA", 200) }),
    );
  });

  it("takes call AND result away together, never just the result", () => {
    // Removing both sides is safe; removing a result and leaving its call is the
    // poison `pruneOrphanToolCalls` exists to clean up.
    const history = [
      assistant("a1", toolCall("output-available", "c1", reading("VIEJA", 500))),
      user("u1", "sigue"),
      assistant("a2", toolCall("output-available", "c2", reading("FRESCA", 500))),
    ];

    const { messages } = dropStaleToolPayloads(history, {
      maxParts: 40,
      proposalChars: 1_000,
      staleChars: 100,
      totalChars: 700,
    });

    const survivors = JSON.stringify(messages[0]);
    expect(survivors).not.toContain("c1");
    expect(survivors).not.toContain("VIEJA");
    expect(JSON.stringify(messages[2])).toContain("c2");
  });

  it("takes away every channel of the part, not just its output", () => {
    // Every one of these fields reaches the provider (`input` as the call's input,
    // `errorText` and `approval.reason` as the result), so swapping `output`
    // alone would leave the payload — and its cost — untouched.
    const history = [
      assistant("a1", {
        type: "tool-get_financial_context",
        toolCallId: "c1",
        state: "output-error",
        input: { relleno: "i".repeat(5_000) },
        rawInput: { relleno: "r".repeat(5_000) },
        errorText: "e".repeat(5_000),
        approval: { id: "ap1", approved: false, reason: "a".repeat(5_000) },
      }),
      user("u1", "sigue"),
      assistant("a2", toolCall("output-available", "c2", reading("FRESCA", 100))),
    ];

    const { messages } = dropStaleToolPayloads(history, {
      maxParts: 40,
      proposalChars: 1_000,
      staleChars: 100,
      totalChars: 1_000,
    });

    const survivors = JSON.stringify(messages[0]);
    expect(survivors).not.toContain("iiii");
    expect(survivors).not.toContain("rrrr");
    expect(survivors).not.toContain("eeee");
    expect(survivors).not.toContain("aaaa");
    expect(survivors.length).toBeLessThan(400);
  });

  it("bounds the total by the NUMBER of parts, not only by their size", () => {
    // The dimension nothing caps: a client can put thousands of tiny parts in ONE
    // message. Swapping payloads instead of dropping parts made this INFLATE — a
    // 619 000-character body became 2 338 652 characters of prompt.
    const parts = Array.from({ length: 10_000 }, (_, index) => ({
      type: "tool-a",
      toolCallId: `${index}`,
      state: "output-denied",
    }));
    const history = [
      assistant("a1", ...parts),
      user("u1", "sigue"),
    ] as unknown as UIMessage[];

    const { messages } = dropStaleToolPayloads(history, BUDGET);

    expect(JSON.stringify(messages).length).toBeLessThan(
      BUDGET.totalChars + DROPPED_TOOL_PAYLOAD_NOTE.length + 500,
    );
  });

  it("bounds the total by their size too", () => {
    const history = Array.from({ length: 40 }, (_, index) =>
      assistant(
        `a${index}`,
        toolCall("output-available", `c${index}`, reading("X", 20_000)),
      ),
    );

    const { messages } = dropStaleToolPayloads(history, BUDGET);

    // 40 notes at most, one per message — the term that used to be per PART.
    expect(JSON.stringify(messages).length).toBeLessThan(
      BUDGET.totalChars + 40 * (DROPPED_TOOL_PAYLOAD_NOTE.length + 40),
    );
  });

  it("spares a proposal the user may be about to confirm", () => {
    // A retired proposal would leave the model unable to see what it proposed
    // when the user says «sí»: it could re-propose, or claim it is already done.
    // With a REAL fresh reading in front of it: `get_snapshot_history` with summary
    // rows is 42 550 characters, and charging the proposal after it is what made it
    // vanish exactly when the user was about to confirm.
    const history = [
      assistant("a1", {
        type: "tool-propose_correction",
        toolCallId: "p1",
        state: "output-available",
        input: {},
        output: reading("PROPUESTA", 20_000),
      }),
      user("u1", "déjame pensarlo"),
      assistant("a2", toolCall("output-available", "c1", reading("LECTURA", 42_550))),
      user("u2", "sí, hazlo"),
    ];

    const { messages, droppedToolCallIds } = dropStaleToolPayloads(history, BUDGET);

    // BOTH survive: charging the proposal first starved the reading this turn's
    // answer stands on, and charging it last made it vanish when it mattered.
    expect(droppedToolCallIds).toEqual([]);
    expect(JSON.stringify(messages[0])).toContain("PROPUESTA");
    expect(JSON.stringify(messages[2])).toContain("LECTURA");
  });

  it("drops a part whose tool name could not be one of ours", () => {
    // The name is the ONE field the SDK writes twice — call and result — so a
    // 47 000-character `type` fitted a 48 000 ceiling and landed 94 285 in the
    // prompt. No real tool name is longer than ~34 characters.
    const history = [
      assistant("a1", {
        type: `tool-${"A".repeat(47_000)}`,
        toolCallId: "c1",
        state: "output-available",
        input: {},
        output: { ok: true },
      }),
      user("u1", "sigue"),
    ] as unknown as UIMessage[];

    const { messages, droppedToolCallIds } = dropStaleToolPayloads(history, BUDGET);

    expect(droppedToolCallIds).toEqual(["c1"]);
    expect(JSON.stringify(messages)).not.toContain("AAAA");
  });

  it("does nothing when everything fits, by identity", () => {
    const history = [
      assistant("a1", toolCall("output-available", "c1", reading("UNA", 10))),
      user("u1", "sigue"),
    ];

    const { messages, droppedToolCallIds } = dropStaleToolPayloads(history, BUDGET);

    expect(droppedToolCallIds).toEqual([]);
    expect(messages).toBe(history);
  });

  it("preserves message order and the parts it does not retire", () => {
    const history = [
      user("u1", "una"),
      assistant(
        "a1",
        { type: "text", text: "respuesta vieja" },
        toolCall("output-available", "c1", reading("VIEJA", 400)),
      ),
      user("u2", "dos"),
      assistant("a2", toolCall("output-available", "c2", reading("FRESCA", 400))),
      user("u3", "tres"),
    ];

    const { messages } = dropStaleToolPayloads(history, {
      maxParts: 40,
      proposalChars: 1_000,
      staleChars: 100,
      totalChars: 600,
    });

    expect(messages.map((message) => message.id)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
    expect(messages[1]?.parts[0]).toEqual({ type: "text", text: "respuesta vieja" });
  });

  it("never mutates the history it was given", () => {
    const history = [
      assistant("a1", toolCall("output-available", "c1", reading("VIEJA", 400))),
      assistant("a2", toolCall("output-available", "c2", reading("FRESCA", 400))),
    ];
    const before = JSON.parse(JSON.stringify(history));

    dropStaleToolPayloads(history, {
      maxParts: 40,
      proposalChars: 1_000,
      staleChars: 100,
      totalChars: 600,
    });

    expect(history).toEqual(before);
  });
});

describe("withoutToolParts", () => {
  it("leaves the prose to be measured alone", () => {
    const history = [
      user("u1", "hola"),
      assistant("a1", toolCall("output-available", "c1", { relleno: "x".repeat(1000) })),
    ];

    // The point of the split (#1260): the prose left behind is tiny.
    expect(JSON.stringify(withoutToolParts(history)).length).toBeLessThan(200);
  });

  it("leaves every non-tool part in place", () => {
    const history = [
      assistant(
        "a1",
        { type: "text", text: "respuesta" },
        toolCall("output-available", "c1", { ok: true }),
        { type: "data-attachment-extraction", data: { fileName: "x.csv" } },
      ),
    ];

    const stripped = withoutToolParts(history) as Array<{
      parts: Array<{ type: string }>;
    }>;

    expect(stripped[0]?.parts.map((part) => part.type)).toEqual([
      "text",
      "data-attachment-extraction",
    ]);
  });

  it("survives a malformed message instead of throwing", () => {
    // It runs BEFORE the shape check in the route, so it meets raw client input.
    expect(withoutToolParts([null, 3, {}, { parts: "no" }])).toEqual([
      null,
      3,
      {},
      { parts: "no" },
    ]);
  });
});

describe("correctFabricatedProposalClaims (#1262)", () => {
  const claim = "He preparado la propuesta de corrección para el saldo.";

  it("tells the model it never prepared the proposal it claimed", () => {
    // Without this the fabricated sentence IS the model's context next turn, and
    // what it does with it is double down.
    const { messages, correctedMessageIds } = correctFabricatedProposalClaims([
      { id: "u1", parts: [{ text: "Actualiza el saldo", type: "text" }], role: "user" },
      { id: "a1", parts: [{ text: claim, type: "text" }], role: "assistant" },
    ]);

    expect(correctedMessageIds).toEqual(["a1"]);
    expect(messages[1]!.parts.at(-1)).toEqual({
      text: FABRICATED_PROPOSAL_MODEL_NOTE,
      type: "text",
    });
    // The original prose is kept: it is what the user read on screen.
    expect(messages[1]!.parts[0]).toEqual({ text: claim, type: "text" });
  });

  function turnWith(output: unknown): UIMessage[] {
    return [
      {
        id: "a1",
        parts: [
          { text: claim, type: "text" },
          {
            input: {},
            output,
            state: "output-available",
            toolCallId: "call-1",
            type: "tool-propose_correction",
          } as unknown as UIMessage["parts"][number],
        ],
        role: "assistant",
      },
    ];
  }

  it("says nothing when the turn really prepared a proposal", () => {
    const messages = turnWith(correctionProposalOutput());

    const result = correctFabricatedProposalClaims(messages);

    expect(result.correctedMessageIds).toEqual([]);
    expect(result.messages).toBe(messages);
  });

  it("corrects the turn whose proposal call worthline rejected (#1468)", () => {
    // The model called the lane, the lane said no, and the prose claimed success.
    // Left uncorrected, that sentence is the model's own context next turn.
    const { messages, correctedMessageIds } = correctFabricatedProposalClaims(
      turnWith({ error: "operation_document_required" }),
    );

    expect(correctedMessageIds).toEqual(["a1"]);
    expect(messages[0]!.parts.at(-1)).toEqual({
      text: FABRICATED_PROPOSAL_MODEL_NOTE,
      type: "text",
    });
  });

  it("does not accuse a turn whose proposal call was cut off mid-stream", () => {
    // The ordering hazard: `pruneOrphanToolCalls` REMOVES that part, so running
    // this check after it would turn an interrupted real proposal into a
    // fabrication. It calls the tool for real; the defect calls nothing.
    const interrupted: UIMessage[] = [
      {
        id: "a1",
        parts: [
          { text: claim, type: "text" },
          {
            input: {},
            state: "input-available",
            toolCallId: "call-1",
            type: "tool-propose_correction",
          } as unknown as UIMessage["parts"][number],
        ],
        role: "assistant",
      },
    ];

    expect(correctFabricatedProposalClaims(interrupted).correctedMessageIds).toEqual([]);
    // And after the prune the part is gone, which is exactly why order matters.
    const pruned = pruneOrphanToolCalls(interrupted).messages;
    expect(correctFabricatedProposalClaims(pruned).correctedMessageIds).toEqual(["a1"]);
  });

  it("returns the same array when there is nothing to correct", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        parts: [{ text: "Tu saldo es 100 €.", type: "text" }],
        role: "assistant",
      },
    ];

    expect(correctFabricatedProposalClaims(messages).messages).toBe(messages);
  });
});

describe("correctFabricatedMaintainerAlertClaims (#1525)", () => {
  /** The turn from the transcript: the gate refused, the prose announced success. */
  const claim = "Te confirmo que he registrado la incidencia como una limitación.";

  function turnWith(...parts: unknown[]): UIMessage[] {
    return [
      user("u1", "levanta una incidencia sobre esto"),
      assistant("a1", { text: claim, type: "text" }, ...parts),
      user("u2", "¿me das el número de ticket?"),
    ];
  }

  it("tells the model no incident exists when the gate refused the call", () => {
    // Without this the fabricated sentence IS the model's context next turn, and the
    // measured failure mode is doubling down — the user had to ask for a ticket
    // number before the assistant admitted there was none.
    const { messages, correctedMessageIds } = correctFabricatedMaintainerAlertClaims(
      turnWith(refusedAlertPart()),
    );

    expect(correctedMessageIds).toEqual(["a1"]);
    expect(messages[1]!.parts.at(-1)).toEqual({
      text: FABRICATED_ALERT_MODEL_NOTE,
      type: "text",
    });
    // The original prose is kept: it is what the user read on screen.
    expect(messages[1]!.parts[0]).toEqual({ text: claim, type: "text" });
  });

  it("corrects the turn that claimed one without calling the tool at all", () => {
    expect(
      correctFabricatedMaintainerAlertClaims(turnWith()).correctedMessageIds,
    ).toEqual(["a1"]);
  });

  it("leaves the turn alone when the alert really was raised", () => {
    const history = turnWith(raisedAlertPart());
    const { messages, correctedMessageIds } =
      correctFabricatedMaintainerAlertClaims(history);

    expect(correctedMessageIds).toEqual([]);
    expect(messages).toBe(history);
  });

  it("leaves the interrupted call alone, and does so BEFORE the prune", () => {
    // The tool writes through the control plane before it returns, so that alert may
    // really exist. Running after `pruneOrphanToolCalls` would remove the part and
    // leave nothing to tell it apart from an invented ceremony — which is why the
    // route chains this repair first.
    const history = turnWith(inFlightAlertPart());
    expect(correctFabricatedMaintainerAlertClaims(history).correctedMessageIds).toEqual(
      [],
    );
    expect(
      correctFabricatedMaintainerAlertClaims(pruneOrphanToolCalls(history).messages)
        .correctedMessageIds,
    ).toEqual(["a1"]);
  });

  it("leaves an honest turn untouched", () => {
    const history = [
      user("u1", "levanta una incidencia sobre esto"),
      assistant("a1", {
        text: "No puedo levantar una incidencia por esto: no hay ningún descuadre de cifras.",
        type: "text",
      }),
    ];

    expect(correctFabricatedMaintainerAlertClaims(history).correctedMessageIds).toEqual(
      [],
    );
    expect(correctFabricatedMaintainerAlertClaims(history).messages).toBe(history);
  });
});
