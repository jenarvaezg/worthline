import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  collapseStaleToolOutputs,
  INTERRUPTED_PROPOSAL_NOTE,
  pruneOrphanToolCalls,
  RETIRED_TOOL_OUTPUT,
  withoutToolParts,
} from "./chat-history";

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

const BUDGET = { staleChars: 24_000, totalChars: 48_000 };

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

describe("collapseStaleToolOutputs", () => {
  const reading = (marker: string, chars: number) => ({
    marker,
    relleno: "x".repeat(chars),
  });

  it("retires the older readings and keeps the freshest one verbatim", () => {
    const history = [
      assistant("a1", toolCall("output-available", "c1", reading("VIEJA", 200))),
      user("u1", "sigue"),
      assistant("a2", toolCall("output-available", "c2", reading("FRESCA", 200))),
      user("u2", "y más"),
    ];

    const { messages, collapsedToolCallIds } = collapseStaleToolOutputs(history, {
      staleChars: 100,
      totalChars: 400,
    });

    expect(collapsedToolCallIds).toEqual(["c1"]);
    const parts = messages.map((message) => message.parts[0] as { output?: unknown });
    expect(parts[0]?.output).toEqual(RETIRED_TOOL_OUTPUT);
    expect(parts[2]?.output).toEqual(reading("FRESCA", 200));
  });

  it("keeps the call/result pair intact — only the payload is swapped", () => {
    const history = [
      assistant("a1", toolCall("output-available", "c1", reading("VIEJA", 500))),
      user("u1", "sigue"),
      assistant("a2", toolCall("output-available", "c2", reading("FRESCA", 500))),
    ];

    const { messages } = collapseStaleToolOutputs(history, {
      staleChars: 100,
      totalChars: 700,
    });

    const retired = messages[0]?.parts[0] as {
      state?: string;
      toolCallId?: string;
      type?: string;
    };
    expect(retired.state).toBe("output-available");
    expect(retired.toolCallId).toBe("c1");
    expect(retired.type).toBe("tool-get_financial_context");
  });

  it("retires the whole part, not just its output", () => {
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

    const { messages } = collapseStaleToolOutputs(history, {
      staleChars: 100,
      totalChars: 1_000,
    });

    const retired = JSON.stringify(messages[0]?.parts[0]);
    expect(retired).not.toContain("iiii");
    expect(retired).not.toContain("rrrr");
    expect(retired).not.toContain("eeee");
    expect(retired).not.toContain("aaaa");
    expect(retired.length).toBeLessThan(400);
  });

  it("bounds the total whatever the client sends", () => {
    // The client writes these parts. Forty of them, each under the per-part
    // allowance, must not add up to an unbounded prompt.
    const history = Array.from({ length: 40 }, (_, index) =>
      assistant(
        `a${index}`,
        toolCall("output-available", `c${index}`, reading("X", 20_000)),
      ),
    );

    const { messages } = collapseStaleToolOutputs(history, BUDGET);

    const kept = JSON.stringify(messages).length;
    expect(kept).toBeLessThan(BUDGET.totalChars + 10_000);
  });

  it("spares a proposal the user may be about to confirm", () => {
    // A retired proposal would leave the model unable to see what it proposed
    // when the user says «sí»: it could re-propose, or claim it is already done.
    const history = [
      assistant("a1", {
        type: "tool-propose_correction",
        toolCallId: "p1",
        state: "output-available",
        input: {},
        output: reading("PROPUESTA", 20_000),
      }),
      user("u1", "déjame pensarlo"),
      assistant("a2", toolCall("output-available", "c1", reading("LECTURA", 20_000))),
      user("u2", "sí, hazlo"),
    ];

    const { messages, collapsedToolCallIds } = collapseStaleToolOutputs(history, BUDGET);

    expect(collapsedToolCallIds).not.toContain("p1");
    expect(JSON.stringify(messages[0])).toContain("PROPUESTA");
  });

  it("does nothing when everything fits, by identity", () => {
    const history = [
      assistant("a1", toolCall("output-available", "c1", reading("UNA", 10))),
      user("u1", "sigue"),
    ];

    const { messages, collapsedToolCallIds } = collapseStaleToolOutputs(history, BUDGET);

    expect(collapsedToolCallIds).toEqual([]);
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

    const { messages } = collapseStaleToolOutputs(history, {
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

    collapseStaleToolOutputs(history, { staleChars: 100, totalChars: 600 });

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
