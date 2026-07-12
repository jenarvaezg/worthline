import { APICallError, LoadAPIKeyError } from "ai";

export type ProviderFailureClassification =
  | "request_too_large"
  | "quota_exhausted"
  | "provider_unavailable"
  | "invalid_credential";

export interface FailoverProvider {
  provider: string;
  modelId: string;
}

export interface ProviderFailoverLog {
  event:
    | "assistant_provider_attempt"
    | "assistant_provider_rejected"
    | "assistant_provider_selected";
  attempt: number;
  provider: string;
  modelId: string;
  classification?: ProviderFailureClassification | "non_failover";
}

interface StreamPart {
  type: string;
  error?: unknown;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current !== undefined && chain.length < 5) {
    chain.push(current);
    if (typeof current !== "object" || current === null || !("cause" in current)) break;
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function searchableErrorText(error: unknown): string {
  return errorChain(error)
    .flatMap((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return [];
      const apiError = candidate as {
        message?: unknown;
        responseBody?: unknown;
        data?: unknown;
      };
      const values = [apiError.message, apiError.responseBody];
      if (apiError.data !== undefined) {
        try {
          values.push(JSON.stringify(apiError.data));
        } catch {
          // Classification is best-effort; provider data is never logged.
        }
      }
      return values.filter((value): value is string => typeof value === "string");
    })
    .join(" ");
}

/** Classify only failures that are safe to retry against another admitted provider. */
export function classifyPreOutputProviderError(
  error: unknown,
): ProviderFailureClassification | null {
  const chain = errorChain(error);
  const apiError = chain.find(APICallError.isInstance);
  const text = searchableErrorText(error);

  if (chain.some(LoadAPIKeyError.isInstance)) return "invalid_credential";
  if (
    apiError?.statusCode === 401 ||
    apiError?.statusCode === 403 ||
    /invalid (?:api )?key|api key (?:is )?(?:invalid|missing)|authentication failed|unauthorized/i.test(
      text,
    )
  ) {
    return "invalid_credential";
  }
  if (
    apiError?.statusCode === 429 &&
    /request(?: is)? too large|request_too_large|context (?:length|window).*(?:exceed|large)/i.test(
      text,
    )
  ) {
    return "request_too_large";
  }
  if (
    apiError?.statusCode === 429 ||
    /quota (?:exhausted|exceeded)|rate limit|too many requests|tokens per day/i.test(text)
  ) {
    return "quota_exhausted";
  }
  if (apiError?.statusCode !== undefined && apiError.statusCode >= 500) {
    return "provider_unavailable";
  }
  return null;
}

function streamWithPrefix<T>(
  prefix: readonly T[],
  reader: ReadableStreamDefaultReader<T>,
): ReadableStream<T> {
  const pending = [...prefix];
  return new ReadableStream<T>({
    async pull(controller) {
      const next = pending.shift();
      if (next !== undefined) {
        controller.enqueue(next);
        return;
      }
      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function streamFromParts<T>(parts: readonly T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function sanitizedErrorPart<Part extends StreamPart>(): Part {
  return {
    type: "error",
    error: new Error("Provider request failed."),
  } as Part;
}

async function discardReader<T>(reader: ReadableStreamDefaultReader<T>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cleanup must never replace the classified provider rejection.
  }
  try {
    reader.releaseLock();
  } catch {
    // An errored or already released reader needs no further cleanup.
  }
}

function isOutputBearingPart(part: StreamPart): boolean {
  switch (part.type) {
    case "start":
    case "start-step":
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
    case "tool-input-start":
    case "tool-input-end":
    case "finish-step":
    case "finish":
    case "abort":
      return false;
    case "text-delta":
    case "reasoning-delta": {
      const value =
        (part as { text?: unknown; delta?: unknown }).text ??
        (part as { delta?: unknown }).delta;
      return typeof value === "string" && value.length > 0;
    }
    case "tool-input-delta": {
      const delta = (part as { delta?: unknown }).delta;
      return typeof delta === "string" && delta.length > 0;
    }
    default:
      return true;
  }
}

function logRejected(
  log: (entry: ProviderFailoverLog) => void,
  provider: FailoverProvider,
  attempt: number,
  classification: ProviderFailureClassification,
): void {
  log({
    event: "assistant_provider_rejected",
    attempt,
    provider: provider.provider,
    modelId: provider.modelId,
    classification,
  });
}

export async function streamWithProviderFailover<
  Provider extends FailoverProvider,
  Part extends StreamPart,
>({
  providers,
  startStream,
  log,
}: {
  providers: readonly Provider[];
  startStream: (provider: Provider) => ReadableStream<Part>;
  log: (entry: ProviderFailoverLog) => void;
}): Promise<{ provider: Provider; stream: ReadableStream<Part> } | null> {
  for (const [index, provider] of providers.entries()) {
    const attempt = index + 1;
    log({
      event: "assistant_provider_attempt",
      attempt,
      provider: provider.provider,
      modelId: provider.modelId,
    });

    let stream: ReadableStream<Part>;
    try {
      stream = startStream(provider);
    } catch (error) {
      const classification = classifyPreOutputProviderError(error);
      if (classification === null) {
        log({
          event: "assistant_provider_selected",
          attempt,
          provider: provider.provider,
          modelId: provider.modelId,
          classification: "non_failover",
        });
        return { provider, stream: streamFromParts([sanitizedErrorPart<Part>()]) };
      }
      logRejected(log, provider, attempt, classification);
      continue;
    }

    const reader = stream.getReader();
    const prefix: Part[] = [];
    while (true) {
      let result: ReadableStreamReadResult<Part>;
      try {
        result = await reader.read();
      } catch (error) {
        const classification = classifyPreOutputProviderError(error);
        await discardReader(reader);
        if (classification === null) {
          log({
            event: "assistant_provider_selected",
            attempt,
            provider: provider.provider,
            modelId: provider.modelId,
            classification: "non_failover",
          });
          return {
            provider,
            stream: streamFromParts([...prefix, sanitizedErrorPart<Part>()]),
          };
        }
        logRejected(log, provider, attempt, classification);
        break;
      }
      if (result.done) {
        await discardReader(reader);
        logRejected(log, provider, attempt, "provider_unavailable");
        break;
      }

      const part = result.value;
      prefix.push(part);
      if (part.type === "error") {
        const classification = classifyPreOutputProviderError(part.error);
        if (classification !== null) {
          await discardReader(reader);
          logRejected(log, provider, attempt, classification);
          break;
        }

        log({
          event: "assistant_provider_selected",
          attempt,
          provider: provider.provider,
          modelId: provider.modelId,
          classification: "non_failover",
        });
        prefix[prefix.length - 1] = sanitizedErrorPart<Part>();
        return { provider, stream: streamWithPrefix(prefix, reader) };
      }
      if (!isOutputBearingPart(part)) continue;

      log({
        event: "assistant_provider_selected",
        attempt,
        provider: provider.provider,
        modelId: provider.modelId,
      });
      return { provider, stream: streamWithPrefix(prefix, reader) };
    }
  }

  return null;
}
