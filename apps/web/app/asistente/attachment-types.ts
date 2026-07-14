export const MAX_ATTACHMENT_FILE_NAME_CHARS = 255;

/** Client-safe v1 type catalog shared by picker, transport and server validation. */
export const ATTACHMENT_TYPES_V1 = [
  {
    extensions: [".png"],
    fallbackMimeType: "image/png",
    kind: "image",
    mimeTypes: ["image/png"],
  },
  {
    extensions: [".jpeg", ".jpg"],
    fallbackMimeType: "image/jpeg",
    kind: "image",
    mimeTypes: ["image/jpeg"],
  },
  {
    extensions: [".webp"],
    fallbackMimeType: "image/webp",
    kind: "image",
    mimeTypes: ["image/webp"],
  },
  {
    extensions: [".heic"],
    fallbackMimeType: "image/heic",
    kind: "image",
    mimeTypes: ["image/heic"],
  },
  {
    extensions: [".heif"],
    fallbackMimeType: "image/heif",
    kind: "image",
    mimeTypes: ["image/heif"],
  },
  {
    extensions: [".csv"],
    fallbackMimeType: "text/csv",
    kind: "spreadsheet",
    mimeTypes: ["application/csv", "application/vnd.ms-excel", "text/csv"],
  },
  {
    extensions: [".xlsx"],
    fallbackMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "spreadsheet",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  },
] as const;

export const ASSISTANT_ATTACHMENT_ACCEPT = ATTACHMENT_TYPES_V1.flatMap((type) => [
  ...type.extensions,
  ...type.mimeTypes,
]).join(",");

export function attachmentMimeTypeForFileName(fileName: string): string {
  const normalized = fileName.trim().toLowerCase();
  return (
    ATTACHMENT_TYPES_V1.find((type) =>
      type.extensions.some((extension) => normalized.endsWith(extension)),
    )?.fallbackMimeType ?? ""
  );
}
