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

/** Spanish labels for geography buckets — reused by admin CRUD (S4). */
export const EXPOSURE_GEOGRAPHY_LABELS: ReadonlyArray<{
  bucket: ExposureGeographyBucket;
  label: string;
}> = [
  { bucket: "us", label: "EE. UU." },
  { bucket: "europe_developed", label: "Europa desarrollada" },
  { bucket: "japan", label: "Japón" },
  { bucket: "pacific_developed", label: "Pacífico desarrollado" },
  { bucket: "emerging", label: "Emergentes" },
  { bucket: "other", label: "Otros" },
];

/** Spanish labels for asset-class buckets — reused by admin CRUD (S4). */
export const EXPOSURE_ASSET_CLASS_LABELS: ReadonlyArray<{
  bucket: ExposureAssetClassBucket;
  label: string;
}> = [
  { bucket: "equity", label: "Renta variable" },
  { bucket: "bond", label: "Renta fija" },
  { bucket: "cash", label: "Efectivo" },
  { bucket: "commodity", label: "Materia prima" },
  { bucket: "property", label: "Inmobiliario" },
  { bucket: "crypto", label: "Cripto" },
  { bucket: "mixed", label: "Mixto" },
];
