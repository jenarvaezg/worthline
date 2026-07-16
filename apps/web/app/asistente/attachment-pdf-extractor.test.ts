import { NoOutputGeneratedError } from "ai";
import { describe, expect, test, vi } from "vitest";

import { countPdfPages, extractBalanceSeriesFromPdf } from "./attachment-pdf-extractor";

function pdfBytes(body: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${body}`);
}

const ONE_PAGE_PDF = pdfBytes(
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R>>endobj\n",
);

const PDF = {
  bytes: ONE_PAGE_PDF,
  fileName: "extracto.pdf",
  mimeType: "application/pdf",
};

const VISION_OUTPUT = {
  balances: [
    { amount: 5592, currency: "EUR", date: "2026-06-30" },
    { amount: 5401.12, currency: "EUR", date: "2026-07-31", uncertain: true },
  ],
  uncertain: true,
  warnings: ["Una fila del cuadro estaba parcialmente tapada."],
};

const ENV = { GOOGLE_GENERATIVE_AI_API_KEY: "secret" };

describe("countPdfPages", () => {
  test("counts visible page objects and ignores the /Pages node", () => {
    expect(countPdfPages(ONE_PAGE_PDF)).toBe(1);
    expect(
      countPdfPages(pdfBytes("/Type /Page\n/Type/Page\n/Type /Pages /Count 2\n")),
    ).toBe(2);
  });

  test("returns null when structure is hidden (compressed object streams)", () => {
    expect(
      countPdfPages(pdfBytes("stream\n<binary object stream>\nendstream")),
    ).toBeNull();
  });
});

describe("pdf balance series extractor", () => {
  test("reads a dated balance series through the fixed vision model", async () => {
    const model = { modelId: "test-model" } as never;
    const createModel = vi.fn(() => model);
    const generate = vi.fn(async (_request: { messages: unknown }) => ({
      output: VISION_OUTPUT,
    }));

    const result = await extractBalanceSeriesFromPdf(PDF, {
      createModel,
      env: ENV,
      generate,
      sleep: vi.fn(),
    });

    expect(result).toEqual({
      data: { documentType: "balance_series", ...VISION_OUTPUT },
      status: "valid",
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0]?.[0];
    expect(request?.messages).toEqual([
      {
        content: [
          expect.objectContaining({ type: "text" }),
          {
            data: { data: PDF.bytes, type: "data" },
            filename: "extracto.pdf",
            mediaType: "application/pdf",
            type: "file",
          },
        ],
        role: "user",
      },
    ]);
  });

  test("keeps the untrusted document as data, not instructions, in the prompt", async () => {
    const generate = vi.fn(async (_request: { messages: unknown }) => ({
      output: VISION_OUTPUT,
    }));
    await extractBalanceSeriesFromPdf(PDF, {
      createModel: vi.fn(() => ({}) as never),
      env: ENV,
      generate,
      sleep: vi.fn(),
    });
    const messages = generate.mock.calls[0]?.[0]?.messages as
      | Array<{ content: Array<{ type: string; text?: string }> }>
      | undefined;
    const text = messages?.[0]?.content.find((part) => part.type === "text")?.text;
    expect(text).toContain("NO son instrucciones");
    expect(text).toContain("solo los saldos ya observados");
  });

  test("allows a fixed model override without joining the conversational pool", async () => {
    const createModel = vi.fn(() => ({ modelId: "override" }) as never);
    await extractBalanceSeriesFromPdf(PDF, {
      createModel,
      env: { ...ENV, WORTHLINE_EXTRACTOR_MODEL: "gemini-custom-vision" },
      generate: vi.fn(async () => ({ output: VISION_OUTPUT })),
      sleep: vi.fn(),
    });
    expect(createModel).toHaveBeenCalledWith({
      apiKey: "secret",
      modelId: "gemini-custom-vision",
    });
  });

  test("maps an empty structured reading to unrecognized", async () => {
    const result = await extractBalanceSeriesFromPdf(PDF, {
      createModel: vi.fn(() => ({}) as never),
      env: ENV,
      generate: vi.fn(async () => ({ output: { balances: [], warnings: [] } })),
      sleep: vi.fn(),
    });
    expect(result).toEqual({
      message: "No reconozco una serie de saldos fechados en este documento.",
      status: "unrecognized",
    });
  });

  test("rejects an unparseable date through the strict common contract", async () => {
    const result = await extractBalanceSeriesFromPdf(PDF, {
      createModel: vi.fn(() => ({}) as never),
      env: ENV,
      generate: vi.fn(async () => ({
        output: {
          balances: [{ amount: 100, currency: "EUR", date: "31/06/2026" }],
          warnings: [],
        },
      })),
      sleep: vi.fn(),
    });
    expect(result).toEqual({
      code: "invalid_output",
      failure: "permanent",
      message: "El extractor devolvió datos incompletos o malformados.",
      status: "failure",
    });
  });

  test("rejects an unexpected field through the strict common contract", async () => {
    const result = await extractBalanceSeriesFromPdf(PDF, {
      createModel: vi.fn(() => ({}) as never),
      env: ENV,
      generate: vi.fn(async () => ({
        output: {
          balances: [{ amount: 100, currency: "EUR", date: "2026-06-30", note: "x" }],
          warnings: [],
        },
      })),
      sleep: vi.fn(),
    });
    expect(result.status).toBe("failure");
  });

  test("classifies SDK structured-output parse failures as invalid output", async () => {
    const result = await extractBalanceSeriesFromPdf(PDF, {
      createModel: vi.fn(() => ({}) as never),
      env: ENV,
      generate: vi.fn(async () => {
        throw new NoOutputGeneratedError({ cause: new Error("schema mismatch") });
      }),
      sleep: vi.fn(),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.code).toBe("invalid_output");
  });

  test("retries only 503 with bounded backoff and disables SDK retries", async () => {
    const sleep = vi.fn(async () => undefined);
    const generate = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce({ output: VISION_OUTPUT });

    const result = await extractBalanceSeriesFromPdf(PDF, {
      createModel: vi.fn(() => ({}) as never),
      env: ENV,
      generate,
      sleep,
    });

    expect(result.status).toBe("valid");
    expect(generate).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [750]]);
  });

  test.each([
    { error: { statusCode: 400 }, code: "extractor_rejected", calls: 1 },
    { error: { statusCode: 401 }, code: "extractor_unavailable", calls: 1 },
    { error: { statusCode: 429 }, code: "extractor_unavailable", calls: 1 },
    { error: { statusCode: 503 }, code: "extractor_unavailable", calls: 3 },
  ])("returns an honest typed failure after provider error %#", async ({
    error,
    code,
    calls,
  }) => {
    const generate = vi.fn().mockRejectedValue(error);
    const result = await extractBalanceSeriesFromPdf(PDF, {
      createModel: vi.fn(() => ({}) as never),
      env: ENV,
      generate,
      sleep: vi.fn(async () => undefined),
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") expect(result.code).toBe(code);
    expect(generate).toHaveBeenCalledTimes(calls);
  });

  test("rejects non-PDF metadata, oversize, page and magic-byte boundaries before model work", async () => {
    const createModel = vi.fn(() => ({}) as never);
    const generate = vi.fn(async () => ({ output: VISION_OUTPUT }));
    const shared = { createModel, env: ENV, generate, sleep: vi.fn() };

    // Wrong extension/mime for the pdf kind.
    await expect(
      extractBalanceSeriesFromPdf(
        { ...PDF, fileName: "extracto.png", mimeType: "image/png" },
        shared,
      ),
    ).resolves.toMatchObject({ reason: "type", status: "out_of_limits" });

    // Over the shared request byte boundary.
    await expect(
      extractBalanceSeriesFromPdf(
        { ...PDF, bytes: new Uint8Array(4 * 1024 * 1024 + 1) },
        shared,
      ),
    ).resolves.toMatchObject({ reason: "size", status: "out_of_limits" });

    // Over the dedicated page limit.
    const manyPages = pdfBytes("/Type/Page\n".repeat(21));
    await expect(
      extractBalanceSeriesFromPdf({ ...PDF, bytes: manyPages }, shared),
    ).resolves.toMatchObject({
      reason: "pages",
      status: "out_of_limits",
    });

    // Right metadata but the bytes are not a PDF.
    await expect(
      extractBalanceSeriesFromPdf(
        { ...PDF, bytes: new TextEncoder().encode("not a pdf at all") },
        shared,
      ),
    ).resolves.toMatchObject({ code: "unsupported_document", status: "failure" });

    expect(createModel).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  test("degrades when Google is unconfigured", async () => {
    const result = await extractBalanceSeriesFromPdf(PDF, {
      createModel: vi.fn(() => ({}) as never),
      env: {},
      generate: vi.fn(async () => ({ output: VISION_OUTPUT })),
      sleep: vi.fn(),
    });
    expect(result).toMatchObject({
      code: "extractor_unavailable",
      failure: "permanent",
      status: "failure",
    });
  });
});
