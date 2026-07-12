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
      { provider: "groq", modelId: "llama-3.3-70b-versatile" },
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
    [{ GROQ_API_KEY: "groq" }, ["groq"]],
    [
      {
        GOOGLE_GENERATIVE_AI_API_KEY: "google",
        CEREBRAS_API_KEY: "cerebras",
        GROQ_API_KEY: "groq",
      },
      ["google", "cerebras", "groq"],
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
      GROQ_API_KEY: "groq",
      WORTHLINE_CHAT_PROVIDER_ORDER: "groq,google",
    };

    expect(availableProviderEntries(env).map((entry) => entry.provider)).toEqual([
      "groq",
      "google",
      "cerebras",
    ]);
  });

  it("cannot inject arbitrary providers or duplicates through environment config", () => {
    const env = {
      GOOGLE_GENERATIVE_AI_API_KEY: "google",
      CEREBRAS_API_KEY: "cerebras",
      GROQ_API_KEY: "groq",
      WORTHLINE_CHAT_PROVIDER_ORDER: "evil,groq,groq,unreviewed",
      WORTHLINE_CHAT_MODEL: "evil/arbitrary-model",
    };

    expect(availableProviderEntries(env).map((entry) => entry.provider)).toEqual([
      "groq",
      "google",
      "cerebras",
    ]);
  });

  it("keeps the same default in local, preview, production, and demo", () => {
    const credentials = {
      GOOGLE_GENERATIVE_AI_API_KEY: "google",
      CEREBRAS_API_KEY: "cerebras",
      GROQ_API_KEY: "groq",
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
      ).toEqual(["google", "cerebras", "groq"]);
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
