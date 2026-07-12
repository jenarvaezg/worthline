import { decideSummarizedAdmission } from "./eval/admission";
import { ADMISSION_EVIDENCE, type AdmissionEvidence } from "./eval/admission-evidence";

export const PROVIDERS = ["google", "cerebras", "groq"] as const;
export type AssistantProvider = (typeof PROVIDERS)[number];

export type ProviderCredentialEnvKey =
  | "GOOGLE_GENERATIVE_AI_API_KEY"
  | "CEREBRAS_API_KEY"
  | "GROQ_API_KEY";

export interface ProviderPoolEntry {
  provider: AssistantProvider;
  modelId: string;
  envKey: ProviderCredentialEnvKey;
  validation: AdmissionEvidence;
}

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export const PROVIDER_ORDER_ENV_KEY = "WORTHLINE_CHAT_PROVIDER_ORDER";

/**
 * The production allowlist and its environment-independent default priority.
 * Each mark is the reviewed output of the admission harness, not a synthetic
 * assertion maintained separately from the run evidence.
 */
export const DEFAULT_PROVIDER_ALLOWLIST = [
  {
    provider: "google",
    modelId: "gemini-3.1-flash-lite",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    validation: ADMISSION_EVIDENCE[0],
  },
  {
    provider: "cerebras",
    modelId: "gpt-oss-120b",
    envKey: "CEREBRAS_API_KEY",
    validation: ADMISSION_EVIDENCE[1],
  },
  {
    provider: "groq",
    modelId: "llama-3.3-70b-versatile",
    envKey: "GROQ_API_KEY",
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
      run["passed"] <= 0 ||
      run["passed"] > run["total"] ||
      !positiveCount(run["totalQuestions"]) ||
      !positiveCount(run["executedQuestions"]) ||
      run["executedQuestions"] > run["totalQuestions"]
    ) {
      validationError(`validation mark for ${provider} is empty or incoherent`);
    }

    if (provider === "groq") {
      if (
        validation["status"] !== "grandfathered" ||
        run["complete"] !== false ||
        typeof validation["reason"] !== "string" ||
        validation["reason"].trim().length === 0
      ) {
        validationError("Groq must carry its explicit grandfathered exception");
      }
    } else {
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
