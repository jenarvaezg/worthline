import { decideSummarizedAdmission } from "./eval/admission";
import { ADMISSION_EVIDENCE, type AdmissionEvidence } from "./eval/admission-evidence";

export const PROVIDERS = ["google", "cerebras", "ollama"] as const;
export type AssistantProvider = (typeof PROVIDERS)[number];

export type ProviderCredentialEnvKey =
  | "GOOGLE_GENERATIVE_AI_API_KEY"
  | "CEREBRAS_API_KEY"
  | "WORTHLINE_OLLAMA_BASE_URL";

/** The env key that picks the served model for the self-hosted ollama slot. */
export const OLLAMA_MODEL_ENV_KEY = "WORTHLINE_OLLAMA_MODEL";

/** Optional bearer token for an ollama server that requires one (most do not). */
export const OLLAMA_API_KEY_ENV_KEY = "WORTHLINE_OLLAMA_API_KEY";

export interface ProviderPoolEntry {
  provider: AssistantProvider;
  modelId: string;
  envKey: ProviderCredentialEnvKey;
  /** A self-hosted, user-funded slot (ollama today): model is env-chosen and
   *  the mark is a reference run, not an admission (ADR 0113). */
  selfHosted: boolean;
  validation: AdmissionEvidence;
}

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export const PROVIDER_ORDER_ENV_KEY = "WORTHLINE_CHAT_PROVIDER_ORDER";

/**
 * The production allowlist and its environment-independent default priority.
 * Each mark is the reviewed output of the admission harness, not a synthetic
 * assertion maintained separately from the run evidence.
 *
 * Two entries since #1278, and every one of them a normal admission: the third,
 * Groq's Llama 3.3 70B, was retired because it can no longer accept a turn at all.
 * Its free tier allows 12.000 tokens per minute and refuses on arrival any single
 * request that alone exceeds that allowance; the bare turn measures 14.285 in its
 * own tokenizer. Even a turn that fitted would need up to six such requests inside
 * the same minute (the chat route's step ceiling), so no amount of prompt slimming
 * brings it back. Measured, not estimated: `bun run eval:floor -- --live`.
 */
export const DEFAULT_PROVIDER_ALLOWLIST = [
  {
    provider: "google",
    modelId: "gemini-3.5-flash-lite",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    selfHosted: false,
    validation: ADMISSION_EVIDENCE[0],
  },
  {
    provider: "cerebras",
    modelId: "gpt-oss-120b",
    envKey: "CEREBRAS_API_KEY",
    selfHosted: false,
    validation: ADMISSION_EVIDENCE[1],
  },
  {
    provider: "ollama",
    // The reference tag, not a default the user must serve: at runtime
    // `WORTHLINE_OLLAMA_MODEL` chooses whatever model the server actually has
    // (ADR 0113). It is committed here so the pool can name a pair, price a
    // capacity card, and hold a reference measurement of the interaction.
    modelId: "llama3.2:3b",
    envKey: "WORTHLINE_OLLAMA_BASE_URL",
    selfHosted: true,
    validation: ADMISSION_EVIDENCE[2],
  },
] as const satisfies readonly ProviderPoolEntry[];

const ALLOWED_PAIRS = new Set(
  DEFAULT_PROVIDER_ALLOWLIST.map(({ provider, modelId }) => `${provider}\0${modelId}`),
);

function pairKey(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validationError(message: string): never {
  throw new Error(`Invalid assistant provider allowlist: ${message}`);
}

/**
 * Runtime counterpart to the typed declaration. It deliberately validates
 * unknown input so the admission invariant is directly guard-tested in CI.
 */
export function validateProviderAllowlist(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    validationError("the allowlist must not be empty");
  }

  const seen = new Set<string>();
  for (const rawEntry of value) {
    if (!isRecord(rawEntry)) validationError("every entry must be an object");
    const provider = rawEntry["provider"];
    const modelId = rawEntry["modelId"];
    const envKey = rawEntry["envKey"];
    if (
      typeof provider !== "string" ||
      typeof modelId !== "string" ||
      !ALLOWED_PAIRS.has(pairKey(provider, modelId))
    ) {
      validationError("provider/model pair is outside the reviewed allowlist");
    }
    if (seen.has(provider)) validationError(`duplicate provider ${provider}`);
    seen.add(provider);
    const committed = DEFAULT_PROVIDER_ALLOWLIST.find(
      (entry) => entry.provider === provider,
    );
    if (!committed || envKey !== committed.envKey) {
      validationError(`credential mapping for ${provider} is incoherent`);
    }

    const validation = rawEntry["validation"];
    if (!isRecord(validation) || !isRecord(validation["run"])) {
      validationError(`validation mark for ${provider} is missing`);
    }
    if (validation["provider"] !== provider || validation["model"] !== modelId) {
      validationError(`validation mark for ${provider} names another candidate`);
    }
    const run = validation["run"];
    if (
      typeof run["evaluatedAt"] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(run["evaluatedAt"]) ||
      Number.isNaN(Date.parse(`${run["evaluatedAt"]}T00:00:00Z`)) ||
      !positiveCount(run["total"]) ||
      typeof run["passed"] !== "number" ||
      !Number.isInteger(run["passed"]) ||
      // Zero is allowed here so a self-hosted reference run may fail; the
      // admission verdict below is what forbids a zero on a shared-baseline mark.
      run["passed"] < 0 ||
      run["passed"] > run["total"] ||
      !positiveCount(run["totalQuestions"]) ||
      !positiveCount(run["executedQuestions"]) ||
      run["executedQuestions"] > run["totalQuestions"]
    ) {
      validationError(`validation mark for ${provider} is empty or incoherent`);
    }

    if (committed.selfHosted) {
      // A self-hosted slot holds a reference run, never an admission: the model
      // is user-chosen at runtime, so there is no fixed candidate to admit
      // (ADR 0113). The shape checks above still apply — a missing or
      // incoherent measurement is refused — but pass/fail does not gate it.
      if (validation["status"] !== "self_hosted") {
        validationError(`${provider} is self-hosted and needs a reference mark`);
      }
      continue;
    }
    if (validation["status"] === "self_hosted") {
      validationError(`a self-hosted mark cannot admit ${provider}`);
    }

    // One rule for every shared-baseline entry since #1278 retired Groq: the pool
    // no longer carries a named exception, so an incomplete run cannot admit.
    const verdict = decideSummarizedAdmission({
      complete:
        validation["status"] === "admitted" &&
        run["complete"] === true &&
        run["executedQuestions"] === run["totalQuestions"],
      passed: run["passed"],
      total: run["total"],
    });
    if (!verdict.admitted) {
      validationError(`${provider} does not satisfy normal admission`);
    }
  }
}

validateProviderAllowlist(DEFAULT_PROVIDER_ALLOWLIST);

export function findAllowedProvider(
  provider: AssistantProvider,
  modelId: string,
): ProviderPoolEntry | undefined {
  return DEFAULT_PROVIDER_ALLOWLIST.find(
    (entry) => entry.provider === provider && entry.modelId === modelId,
  );
}

/**
 * Admission is per EXACT provider/model pair for a shared-baseline slot, and per
 * PROVIDER for a self-hosted one (ADR 0113): a self-hosted slot serves whatever
 * the user's env names, so requiring the committed pair there would reject the
 * user's own tag before it ever reached the server. This is what relaxes
 * `requireAdmission` in the shared resolution seam.
 */
export function isAdmittedProvider(candidate: {
  provider: AssistantProvider;
  modelId: string;
}): boolean {
  const slot = DEFAULT_PROVIDER_ALLOWLIST.find(
    (entry) => entry.provider === candidate.provider,
  );
  if (!slot) return false;
  return (
    slot.selfHosted || ALLOWED_PAIRS.has(pairKey(candidate.provider, candidate.modelId))
  );
}

/** The model a self-hosted entry actually serves: the user's env choice, else the reference tag. */
export function servedModelId(
  entry: { provider: AssistantProvider; selfHosted: boolean; modelId: string },
  env: ProviderEnvironment,
): string {
  if (!entry.selfHosted) return entry.modelId;
  return env[OLLAMA_MODEL_ENV_KEY]?.trim() || entry.modelId;
}

export function providerCredentialEnvKey(
  provider: AssistantProvider,
): ProviderCredentialEnvKey {
  const entry = DEFAULT_PROVIDER_ALLOWLIST.find(
    (candidate) => candidate.provider === provider,
  );
  if (!entry) throw new Error(`Unsupported assistant provider: ${provider}.`);
  return entry.envKey;
}

function orderedAllowlist(env: ProviderEnvironment): readonly ProviderPoolEntry[] {
  const configured = (env[PROVIDER_ORDER_ENV_KEY] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is AssistantProvider =>
      PROVIDERS.some((provider) => provider === value),
    );
  const order = [...new Set(configured)];
  for (const entry of DEFAULT_PROVIDER_ALLOWLIST) {
    if (!order.includes(entry.provider)) order.push(entry.provider);
  }
  return order.flatMap((provider) => {
    const entry = DEFAULT_PROVIDER_ALLOWLIST.find(
      (candidate) => candidate.provider === provider,
    );
    return entry ? [entry] : [];
  });
}

/** Entries that can actually be used in this process, in strict priority order. */
export function availableProviderEntries(
  env: ProviderEnvironment = process.env,
): readonly ProviderPoolEntry[] {
  return orderedAllowlist(env).filter((entry) => Boolean(env[entry.envKey]?.trim()));
}
