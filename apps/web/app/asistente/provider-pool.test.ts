import { describe, expect, it } from "vitest";
import { DEFAULT_ADMISSION_THRESHOLD } from "./eval/admission";
import {
  availableProviderEntries,
  DEFAULT_PROVIDER_ALLOWLIST,
  validateProviderAllowlist,
} from "./provider-pool";

describe("validated assistant provider allowlist", () => {
  it("commits one strict default order with real admission marks", () => {
    expect(
      DEFAULT_PROVIDER_ALLOWLIST.map(({ provider, modelId }) => ({ provider, modelId })),
    ).toEqual([
      { provider: "google", modelId: "gemini-3.1-flash-lite" },
      { provider: "cerebras", modelId: "gpt-oss-120b" },
    ]);
    expect(() => validateProviderAllowlist(DEFAULT_PROVIDER_ALLOWLIST)).not.toThrow();
  });

  it.each([
    ["missing mark", [{ provider: "google", modelId: "gemini-3.1-flash-lite" }]],
    [
      "incoherent mark",
      [
        {
          ...DEFAULT_PROVIDER_ALLOWLIST[0],
          validation: DEFAULT_PROVIDER_ALLOWLIST[1]?.validation,
        },
      ],
    ],
    [
      "empty mark",
      [
        {
          ...DEFAULT_PROVIDER_ALLOWLIST[0],
          validation: {
            ...DEFAULT_PROVIDER_ALLOWLIST[0]?.validation,
            run: {
              ...DEFAULT_PROVIDER_ALLOWLIST[0]?.validation.run,
              passed: 0,
              total: 0,
            },
          },
        },
      ],
    ],
    [
      "arbitrary model",
      [
        {
          ...DEFAULT_PROVIDER_ALLOWLIST[0],
          modelId: "gemini-unreviewed",
        },
      ],
    ],
  ])("rejects a %s", (_name, allowlist) => {
    expect(() => validateProviderAllowlist(allowlist)).toThrow();
  });

  it("admits nothing on an incomplete run, with no named exception left", () => {
    // #1278 retired the pool's one grandfathered entry (Groq), and with it the
    // branch that let an incomplete run admit anything. A mark shaped like that
    // exception is now just an incomplete run: rejected, whatever it names.
    const incomplete = [
      {
        ...DEFAULT_PROVIDER_ALLOWLIST[0],
        validation: {
          ...DEFAULT_PROVIDER_ALLOWLIST[0].validation,
          status: "grandfathered",
          reason: "Titular anterior al gate.",
          run: {
            ...DEFAULT_PROVIDER_ALLOWLIST[0].validation.run,
            complete: false,
            executedQuestions: 6,
            totalQuestions: 18,
          },
        },
      },
    ];

    expect(() => validateProviderAllowlist(incomplete)).toThrow(/admission/i);
  });

  it("cannot re-admit the retired provider", () => {
    // The pair is outside the reviewed allowlist now, so neither the model nor a
    // resurrected mark can put Groq back (#1278).
    expect(() =>
      validateProviderAllowlist([
        {
          provider: "groq",
          modelId: "llama-3.3-70b-versatile",
          envKey: "GROQ_API_KEY",
          validation: DEFAULT_PROVIDER_ALLOWLIST[0].validation,
        },
      ]),
    ).toThrow(/allowlist/i);
  });

  it("uses the canonical admission threshold instead of a pool-local copy", () => {
    const total = 1_000;
    const atThreshold = Math.ceil(DEFAULT_ADMISSION_THRESHOLD * total);
    const entryAtThreshold = {
      ...DEFAULT_PROVIDER_ALLOWLIST[0],
      validation: {
        ...DEFAULT_PROVIDER_ALLOWLIST[0].validation,
        run: {
          ...DEFAULT_PROVIDER_ALLOWLIST[0].validation.run,
          passed: atThreshold,
          total,
        },
      },
    };

    expect(() => validateProviderAllowlist([entryAtThreshold])).not.toThrow();
    expect(() =>
      validateProviderAllowlist([
        {
          ...entryAtThreshold,
          validation: {
            ...entryAtThreshold.validation,
            run: { ...entryAtThreshold.validation.run, passed: atThreshold - 1 },
          },
        },
      ]),
    ).toThrow(/admission/i);
  });
});

describe("availableProviderEntries", () => {
  it.each([
    [{}, []],
    [{ GOOGLE_GENERATIVE_AI_API_KEY: "google" }, ["google"]],
    [{ CEREBRAS_API_KEY: "cerebras" }, ["cerebras"]],
    [{ GROQ_API_KEY: "groq" }, []],
    [
      {
        GOOGLE_GENERATIVE_AI_API_KEY: "google",
        CEREBRAS_API_KEY: "cerebras",
      },
      ["google", "cerebras"],
    ],
  ])("filters the credential combination %#", (env, providers) => {
    expect(availableProviderEntries(env).map((entry) => entry.provider)).toEqual(
      providers,
    );
  });

  it("reorders only allowlisted providers and appends omitted entries in default order", () => {
    const env = {
      GOOGLE_GENERATIVE_AI_API_KEY: "google",
      CEREBRAS_API_KEY: "cerebras",
      WORTHLINE_CHAT_PROVIDER_ORDER: "cerebras",
    };

    expect(availableProviderEntries(env).map((entry) => entry.provider)).toEqual([
      "cerebras",
      "google",
    ]);
  });

  it("cannot inject arbitrary providers or duplicates through environment config", () => {
    const env = {
      GOOGLE_GENERATIVE_AI_API_KEY: "google",
      CEREBRAS_API_KEY: "cerebras",
      // `groq` is now one of the arbitrary names too (#1278): a retired provider
      // cannot be re-ordered back into the pool from the environment.
      WORTHLINE_CHAT_PROVIDER_ORDER: "evil,groq,cerebras,cerebras,unreviewed",
      WORTHLINE_CHAT_MODEL: "evil/arbitrary-model",
    };

    expect(availableProviderEntries(env).map((entry) => entry.provider)).toEqual([
      "cerebras",
      "google",
    ]);
  });

  it("keeps the same default in local, preview, production, and demo", () => {
    const credentials = {
      GOOGLE_GENERATIVE_AI_API_KEY: "google",
      CEREBRAS_API_KEY: "cerebras",
    };
    for (const environment of [
      { NODE_ENV: "development" },
      { NODE_ENV: "preview" },
      { NODE_ENV: "production" },
      { NODE_ENV: "production", WORTHLINE_DEMO: "1" },
    ]) {
      expect(
        availableProviderEntries({ ...credentials, ...environment }).map(
          (entry) => entry.provider,
        ),
      ).toEqual(["google", "cerebras"]);
    }
  });

  it("treats blank credentials as absent", () => {
    expect(
      availableProviderEntries({
        GOOGLE_GENERATIVE_AI_API_KEY: "   ",
        CEREBRAS_API_KEY: "",
      }),
    ).toEqual([]);
  });
});
