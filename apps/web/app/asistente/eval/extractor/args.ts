export const DEFAULT_EXTRACTOR_THRESHOLD = 1;

export interface ExtractorEvalArgs {
  model?: string;
  threshold: number;
  output?: string;
  only?: string[];
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function valuesAfter(argv: readonly string[], flag: string): string[] | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const values: string[] = [];
  for (let cursor = index + 1; cursor < argv.length; cursor += 1) {
    const value = argv[cursor];
    if (!value || value.startsWith("--")) break;
    values.push(value);
  }
  if (values.length === 0) throw new Error(`${flag} requires at least one value.`);
  return values;
}

export function parseExtractorEvalArgs(argv: readonly string[]): ExtractorEvalArgs {
  const thresholdValue = valueAfter(argv, "--threshold");
  const threshold = thresholdValue
    ? Number.parseFloat(thresholdValue)
    : DEFAULT_EXTRACTOR_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be a number between 0 and 1.");
  }

  const model = valueAfter(argv, "--model");
  const output = valueAfter(argv, "--output");
  const only = valuesAfter(argv, "--only");
  return {
    threshold,
    ...(model ? { model } : {}),
    ...(output ? { output } : {}),
    ...(only ? { only } : {}),
  };
}
