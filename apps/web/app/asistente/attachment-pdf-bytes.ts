/**
 * Byte-level PDF guards. They belong to the *file family*, not to the question we
 * ask the model, so they live apart from the vision seam: whatever document a PDF
 * turns out to carry, a payload that is not a PDF or is too long to hand over is
 * rejected before any model work.
 */

const PDF_MAGIC = "%PDF-";

/**
 * Best-effort page count from the raw PDF bytes. Uncompressed page objects carry
 * a visible `/Type /Page` marker; a PDF that hides its structure inside compressed
 * object streams returns `null`, and the size limit remains the hard boundary.
 */
export function countPdfPages(bytes: Uint8Array): number | null {
  const text = new TextDecoder("latin1").decode(bytes);
  const matches = text.match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  const count = matches?.length ?? 0;
  return count > 0 ? count : null;
}

/** True when the payload really starts as a PDF, not just claims the type. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return header.includes(PDF_MAGIC);
}
