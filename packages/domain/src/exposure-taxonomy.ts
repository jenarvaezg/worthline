export const EXPOSURE_GEOGRAPHY_BUCKETS = [
  "us",
  "europe_developed",
  "japan",
  "pacific_developed",
  "emerging",
  "other",
] as const;

export type ExposureGeographyBucket = (typeof EXPOSURE_GEOGRAPHY_BUCKETS)[number];

export const EXPOSURE_ASSET_CLASS_BUCKETS = [
  "equity",
  "bond",
  "cash",
  "commodity",
  "property",
  "crypto",
  "mixed",
] as const;

export type ExposureAssetClassBucket = (typeof EXPOSURE_ASSET_CLASS_BUCKETS)[number];

export type ExposureDimension = "geography" | "currency" | "assetClass";
