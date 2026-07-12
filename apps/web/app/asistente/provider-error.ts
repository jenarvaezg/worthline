import { APICallError } from "ai";

export function providerErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current !== undefined && chain.length < 5) {
    chain.push(current);
    if (typeof current !== "object" || current === null || !("cause" in current)) break;
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function providerErrorText(error: unknown): string {
  return providerErrorChain(error)
    .flatMap((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return [];
      const value = candidate as {
        message?: unknown;
        responseBody?: unknown;
        data?: unknown;
      };
      const parts = [value.message, value.responseBody];
      if (value.data !== undefined) {
        try {
          parts.push(JSON.stringify(value.data));
        } catch {
          // Classification is best-effort; provider data is never logged.
        }
      }
      return parts.filter((part): part is string => typeof part === "string");
    })
    .join(" ");
}

export function providerErrorHeader(error: unknown, name: string): string | undefined {
  const apiError = providerErrorChain(error).find(APICallError.isInstance);
  if (!apiError?.responseHeaders) return undefined;
  return Object.entries(apiError.responseHeaders).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
}
