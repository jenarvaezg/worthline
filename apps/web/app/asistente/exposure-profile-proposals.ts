import {
  EXPOSURE_ASSET_CLASS_BUCKETS,
  EXPOSURE_GEOGRAPHY_BUCKETS,
  canHandEnterExposureProfile,
  createExposureProfile,
} from "@worthline/domain";
import type {
  CreateExposureProfileInput,
  DecimalString,
  ExposureAssetClassBucket,
  ExposureBreakdowns,
  ExposureGeographyBucket,
  ExposureProfile,
  Instrument,
} from "@worthline/domain";

import type { WorthlineStore } from "@web/store";

export type ExposureProfileProposalDraft = CreateExposureProfileInput & {
  breakdowns?: ExposureBreakdowns;
};

export interface ExposureProfileProposalReadPort {
  readAssets: () => Promise<
    Array<{ id: string; instrument?: Instrument | null; name: string; type: string }>
  >;
  readInvestmentAssetsWithMeta: () => Promise<
    Array<{ id: string; isin?: string; providerSymbol?: string }>
  >;
  readExposureProfiles: () => Promise<ExposureProfile[]>;
}

export interface ExposureProfileProposalPreviewProfile {
  breakdowns: ExposureBreakdowns;
  hedged: boolean;
  ter: DecimalString | null;
  trackedIndex: string | null;
}

export interface ExposureProfileProposalPreview {
  after: ExposureProfileProposalPreviewProfile;
  before: ExposureProfileProposalPreviewProfile;
  key: string;
  labels: string[];
}

export interface ExposureProfileProposal {
  proposalType: "exposure_profiles";
  drafts: ExposureProfileProposalDraft[];
  previews: ExposureProfileProposalPreview[];
}

export type ExposureProfileProposalParseResult =
  | { ok: true; drafts: ExposureProfileProposalDraft[] }
  | { ok: false; error: string };

export type ExposureProfileProposalBuildResult =
  | { ok: true; proposal: ExposureProfileProposal }
  | { ok: false; error: string };

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const CURRENCY_BUCKET = /^(?:[A-Z]{3}|other)$/;
const MAX_DRAFTS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseDecimal(value: unknown): DecimalString | null {
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}

function parseStringOrNull(value: unknown, max = 160): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

function parseBucketMap<T extends string>(
  raw: unknown,
  isBucket: (bucket: string) => bucket is T,
): Record<T, DecimalString> | null {
  if (!isRecord(raw)) return null;
  const parsed = {} as Record<T, DecimalString>;

  for (const [bucket, value] of Object.entries(raw)) {
    const weight = parseDecimal(value);
    if (!isBucket(bucket) || weight === null) return null;
    parsed[bucket] = weight;
  }

  return parsed;
}

function isGeographyBucket(bucket: string): bucket is ExposureGeographyBucket {
  return (EXPOSURE_GEOGRAPHY_BUCKETS as readonly string[]).includes(bucket);
}

function isAssetClassBucket(bucket: string): bucket is ExposureAssetClassBucket {
  return (EXPOSURE_ASSET_CLASS_BUCKETS as readonly string[]).includes(bucket);
}

function parseBreakdowns(raw: unknown): ExposureBreakdowns | null | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;

  const breakdowns: ExposureBreakdowns = {};
  if (hasOwn(raw, "geography")) {
    const geography = parseBucketMap(raw["geography"], isGeographyBucket);
    if (geography === null) return null;
    breakdowns.geography = geography;
  }
  if (hasOwn(raw, "assetClass")) {
    const assetClass = parseBucketMap(raw["assetClass"], isAssetClassBucket);
    if (assetClass === null) return null;
    breakdowns.assetClass = assetClass;
  }
  if (hasOwn(raw, "currency")) {
    const currency = parseBucketMap(raw["currency"], (bucket): bucket is string =>
      CURRENCY_BUCKET.test(bucket),
    );
    if (currency === null) return null;
    breakdowns.currency = currency;
  }

  return breakdowns;
}

function parseDraft(raw: unknown): ExposureProfileProposalDraft | null {
  if (!isRecord(raw)) return null;
  const key = parseStringOrNull(raw["key"]);
  if (key === undefined || key === null) return null;

  const draft: ExposureProfileProposalDraft = { key };
  if (hasOwn(raw, "trackedIndex")) {
    const trackedIndex = parseStringOrNull(raw["trackedIndex"]);
    if (trackedIndex === undefined) return null;
    draft.trackedIndex = trackedIndex;
  }
  if (hasOwn(raw, "ter")) {
    draft.ter = raw["ter"] === null ? null : parseDecimal(raw["ter"]);
    if (draft.ter === null && raw["ter"] !== null) return null;
  }
  if (hasOwn(raw, "hedged")) {
    if (typeof raw["hedged"] !== "boolean") return null;
    draft.hedged = raw["hedged"];
  }

  const breakdowns = parseBreakdowns(raw["breakdowns"]);
  if (breakdowns === null) return null;
  if (breakdowns !== undefined) draft.breakdowns = breakdowns;

  try {
    createExposureProfile(draft);
  } catch {
    return null;
  }

  return draft;
}

export function parseExposureProfileProposalDrafts(
  raw: unknown,
): ExposureProfileProposalParseResult {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DRAFTS) {
    return { ok: false, error: "El borrador de exposición no es válido." };
  }

  const drafts: ExposureProfileProposalDraft[] = [];
  for (const item of raw) {
    const draft = parseDraft(item);
    if (draft === null) {
      return { ok: false, error: "El borrador de exposición no es válido." };
    }
    drafts.push(draft);
  }

  return { ok: true, drafts };
}

export async function readEligibleExposureProfileKeys(
  store: WorthlineStore,
): Promise<Set<string>> {
  return new Set(
    (
      await readEligibleExposureProfileTargets({
        readAssets: store.assets.readAssets,
        readExposureProfiles: store.exposureProfiles.readExposureProfiles,
        readInvestmentAssetsWithMeta: store.assets.readInvestmentAssetsWithMeta,
      })
    ).keys(),
  );
}

export async function readEligibleExposureProfileTargets(
  store: ExposureProfileProposalReadPort,
): Promise<Map<string, string[]>> {
  const [assets, metas] = await Promise.all([
    store.readAssets(),
    store.readInvestmentAssetsWithMeta(),
  ]);
  const metaById = new Map(metas.map((meta) => [meta.id, meta]));
  const targets = new Map<string, string[]>();

  for (const asset of assets) {
    if (
      asset.type !== "investment" ||
      asset.instrument == null ||
      !canHandEnterExposureProfile(asset.instrument as Instrument)
    ) {
      continue;
    }
    const meta = metaById.get(asset.id);
    const key = meta?.isin ?? meta?.providerSymbol;
    if (key) targets.set(key, [...(targets.get(key) ?? []), asset.name]);
  }

  return targets;
}

export function agentStampedProfile(
  draft: ExposureProfileProposalDraft,
  declaredAt: string,
): ExposureProfile {
  return createExposureProfile({
    ...draft,
    declaredAt,
    source: "agent",
  });
}

function previewProfile(
  profile: ExposureProfile | null,
): ExposureProfileProposalPreviewProfile {
  return {
    breakdowns: profile?.breakdowns ?? {},
    hedged: profile?.hedged ?? false,
    ter: profile?.ter ?? null,
    trackedIndex: profile?.trackedIndex ?? null,
  };
}

function mergePreview(
  current: ExposureProfile | null,
  draft: ExposureProfileProposalDraft,
): ExposureProfileProposalPreviewProfile {
  const before = previewProfile(current);

  return {
    breakdowns: {
      ...before.breakdowns,
      ...(draft.breakdowns ?? {}),
    },
    hedged: draft.hedged ?? before.hedged,
    ter: hasOwn(draft as unknown as Record<string, unknown>, "ter")
      ? (draft.ter ?? null)
      : before.ter,
    trackedIndex: hasOwn(draft as unknown as Record<string, unknown>, "trackedIndex")
      ? (draft.trackedIndex ?? null)
      : before.trackedIndex,
  };
}

export async function buildExposureProfileProposal(
  store: ExposureProfileProposalReadPort,
  rawDrafts: unknown,
): Promise<ExposureProfileProposalBuildResult> {
  const parsed = parseExposureProfileProposalDrafts(rawDrafts);
  if (!parsed.ok) return parsed;

  const [targets, currentProfiles] = await Promise.all([
    readEligibleExposureProfileTargets(store),
    store.readExposureProfiles(),
  ]);
  const currentByKey = new Map(currentProfiles.map((profile) => [profile.key, profile]));
  const previews: ExposureProfileProposalPreview[] = [];

  for (const draft of parsed.drafts) {
    const labels = targets.get(draft.key);
    if (!labels) {
      return { ok: false, error: "La propuesta no apunta a una posición elegible." };
    }
    const current = currentByKey.get(draft.key) ?? null;
    previews.push({
      after: mergePreview(current, draft),
      before: previewProfile(current),
      key: draft.key,
      labels,
    });
  }

  return {
    ok: true,
    proposal: {
      proposalType: "exposure_profiles",
      drafts: parsed.drafts,
      previews,
    },
  };
}
