import { NoOutputGeneratedError } from "ai";
import { describe, expect, test, vi } from "vitest";

import {
  extractPositionsFromImage,
  IMAGE_EXTRACTOR_DEFAULT_MODEL,
} from "./attachment-image-extractor";

const IMAGE = {
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  fileName: "broker.png",
  mimeType: "image/png",
};

interface CapturedGenerationRequest {
  maxRetries: 0;
  messages: unknown;
  model: unknown;
  output: unknown;
}

const VISION_OUTPUT = {
  positions: [
    {
      currency: "USD",
      marketValueEur: 875.25,
      name: "Tesla Inc.",
      ticker: "TSLA",
      uncertain: true,
      units: 4,
    },
  ],
  totalEur: 875.25,
  warnings: ["La divisa original no se distingue con claridad."],
};

describe("image positions extractor", () => {
  test("uses the dedicated Google model and sends structured vision output", async () => {
    const model = { modelId: "test-model" } as never;
    const createModel = vi.fn(() => model);
    const generate = vi.fn(async (_request: CapturedGenerationRequest) => ({
      output: VISION_OUTPUT,
    }));

    const result = await extractPositionsFromImage(IMAGE, {
      createModel,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "secret" },
      generate,
      sleep: vi.fn(),
    });

    expect(result).toEqual({ data: VISION_OUTPUT, status: "valid" });
    expect(createModel).toHaveBeenCalledWith({
      apiKey: "secret",
      modelId: IMAGE_EXTRACTOR_DEFAULT_MODEL,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0]?.[0];
    expect(request).toMatchObject({ maxRetries: 0, model, temperature: 0 });
    expect(request?.messages).toEqual([
      {
        content: [
          expect.objectContaining({ type: "text" }),
          {
            data: { data: IMAGE.bytes, type: "data" },
            filename: "broker.png",
            mediaType: "image/png",
            type: "file",
          },
        ],
        role: "user",
      },
    ]);
    expect(request?.output).toBeDefined();
  });

  test("allows a fixed model override without joining the conversational pool", async () => {
    const createModel = vi.fn(() => ({ modelId: "override" }) as never);

    await extractPositionsFromImage(IMAGE, {
      createModel,
      env: {
        GOOGLE_GENERATIVE_AI_API_KEY: "secret",
        WORTHLINE_EXTRACTOR_MODEL: "gemini-custom-vision",
      },
      generate: vi.fn(async () => ({ output: VISION_OUTPUT })),
      sleep: vi.fn(),
    });

    expect(createModel).toHaveBeenCalledWith({
      apiKey: "secret",
      modelId: "gemini-custom-vision",
    });
  });

  test("maps an empty structured reading to unrecognized", async () => {
    const result = await extractPositionsFromImage(IMAGE, {
      createModel: vi.fn(() => ({}) as never),
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "secret" },
      generate: vi.fn(async () => ({ output: { positions: [], warnings: [] } })),
      sleep: vi.fn(),
    });

    expect(result).toEqual({
      message: "No reconozco posiciones de inversión en esta captura.",
      status: "unrecognized",
    });
  });

  test("validates generated data again through the strict common contract", async () => {
    const result = await extractPositionsFromImage(IMAGE, {
      createModel: vi.fn(() => ({}) as never),
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "secret" },
      generate: vi.fn(async () => ({
        output: {
          positions: [{ ...VISION_OUTPUT.positions[0], extra: "not allowed" }],
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

  test("classifies SDK structured-output parse failures as invalid output", async () => {
    const result = await extractPositionsFromImage(IMAGE, {
      createModel: vi.fn(() => ({}) as never),
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "secret" },
      generate: vi.fn(async () => {
        throw new NoOutputGeneratedError({ cause: new Error("schema mismatch") });
      }),
      sleep: vi.fn(),
    });

    expect(result).toEqual({
      code: "invalid_output",
      failure: "permanent",
      message: "El extractor devolvió datos incompletos o malformados.",
      status: "failure",
    });
  });

  test("retries only 503 with bounded backoff and disables SDK retries", async () => {
    const sleep = vi.fn(async () => undefined);
    const generate = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce({ output: VISION_OUTPUT });

    const result = await extractPositionsFromImage(IMAGE, {
      createModel: vi.fn(() => ({}) as never),
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "secret" },
      generate,
      sleep,
    });

    expect(result.status).toBe("valid");
    expect(generate).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [750]]);
  });

  test.each([
    {
      error: { statusCode: 400 },
      expected: {
        code: "extractor_rejected",
        failure: "permanent",
        message: "No he podido leer esta captura.",
        status: "failure",
      },
      expectedCalls: 1,
    },
    {
      error: { statusCode: 401 },
      expected: {
        code: "extractor_unavailable",
        failure: "permanent",
        message:
          "El lector de capturas no está disponible por un problema de configuración. Puedes seguir conversando sin la captura.",
        status: "failure",
      },
      expectedCalls: 1,
    },
    {
      error: { statusCode: 429 },
      expected: {
        code: "extractor_unavailable",
        failure: "transient",
        message:
          "El lector de capturas no está disponible ahora mismo. Puedes seguir conversando y volver a intentarlo más tarde.",
        status: "failure",
      },
      expectedCalls: 1,
    },
    {
      error: { statusCode: 500 },
      expected: {
        code: "extractor_unavailable",
        failure: "transient",
        message:
          "El lector de capturas no está disponible ahora mismo. Puedes seguir conversando y volver a intentarlo más tarde.",
        status: "failure",
      },
      expectedCalls: 1,
    },
    {
      error: { statusCode: 503 },
      expected: {
        code: "extractor_unavailable",
        failure: "transient",
        message:
          "El lector de capturas no está disponible ahora mismo. Puedes seguir conversando y volver a intentarlo más tarde.",
        status: "failure",
      },
      expectedCalls: 3,
    },
  ])("returns an honest typed failure after provider error %#", async ({
    error,
    expected,
    expectedCalls,
  }) => {
    const generate = vi.fn().mockRejectedValue(error);

    const result = await extractPositionsFromImage(IMAGE, {
      createModel: vi.fn(() => ({}) as never),
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "secret" },
      generate,
      sleep: vi.fn(async () => undefined),
    });

    expect(result).toEqual(expected);
    expect(generate).toHaveBeenCalledTimes(expectedCalls);
  });

  test("checks image limits before model work and degrades when Google is unconfigured", async () => {
    const createModel = vi.fn(() => ({}) as never);
    const generate = vi.fn(async () => ({ output: VISION_OUTPUT }));

    await expect(
      extractPositionsFromImage(
        { ...IMAGE, fileName: "broker.pdf", mimeType: "application/pdf" },
        {
          createModel,
          env: { GOOGLE_GENERATIVE_AI_API_KEY: "secret" },
          generate,
          sleep: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ reason: "type", status: "out_of_limits" });

    await expect(
      extractPositionsFromImage(
        { ...IMAGE, fileName: `${"x".repeat(252)}.png` },
        {
          createModel,
          env: { GOOGLE_GENERATIVE_AI_API_KEY: "secret" },
          generate,
          sleep: vi.fn(),
        },
      ),
    ).resolves.toMatchObject({ reason: "type", status: "out_of_limits" });

    await expect(
      extractPositionsFromImage(IMAGE, {
        createModel,
        env: {},
        generate,
        sleep: vi.fn(),
      }),
    ).resolves.toMatchObject({
      code: "extractor_unavailable",
      failure: "permanent",
      message:
        "El lector de capturas no está disponible en esta instalación. Puedes seguir conversando sin la captura.",
      status: "failure",
    });
    expect(createModel).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
