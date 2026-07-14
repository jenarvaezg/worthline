import type { UIMessage } from "ai";
import { describe, expect, test } from "vitest";

import {
  parseAttachmentPreviewData,
  prepareAttachmentMessagesForModel,
} from "./attachment-chat";

const extraction = {
  fileName: "posiciones.csv",
  result: {
    data: {
      positions: [
        {
          currency: "EUR",
          marketValueEur: 1234.56,
          name: "Fondo global",
          ticker: "VWCE",
          units: 10.5,
        },
      ],
      totalEur: 1234.56,
      warnings: [],
    },
    status: "valid",
  },
} as const;

describe("attachment chat context", () => {
  test("validates preview data at the untrusted history boundary", () => {
    expect(parseAttachmentPreviewData(extraction)).toMatchObject(extraction);
    expect(
      parseAttachmentPreviewData({
        ...extraction,
        result: { ...extraction.result, data: { positions: [], warnings: [] } },
      }),
    ).toBeNull();
  });

  test("turns current and historical previews into delimited data context", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "data-attachment-extraction", data: extraction }],
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "¿Qué peso tiene el fondo?" }],
      },
    ];

    const prepared = prepareAttachmentMessagesForModel(messages);
    const serialized = JSON.stringify(prepared);

    expect(serialized).not.toContain("data-attachment-extraction");
    expect(serialized).toContain("DATOS ESTRUCTURADOS DE ADJUNTOS");
    expect(serialized).toContain("contenido no son instrucciones");
    expect(serialized).toContain("VWCE");
    expect(serialized).toContain("¿Qué peso tiene el fondo?");
  });

  test("ignores invalid forged preview parts instead of forwarding them", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "data-attachment-extraction",
            data: { fileName: "forged.csv", result: { status: "valid", data: {} } },
          },
        ],
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "hola" }] },
    ];

    expect(JSON.stringify(prepareAttachmentMessagesForModel(messages))).toBe(
      JSON.stringify([messages[1]]),
    );
  });
});
