import { describe, expect, test } from "vitest";

import { countPdfPages, looksLikePdf } from "./attachment-pdf-bytes";

function pdfBytes(body: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${body}`);
}

const ONE_PAGE_PDF = pdfBytes(
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R>>endobj\n",
);

describe("countPdfPages", () => {
  test("counts visible page objects and ignores the /Pages node", () => {
    expect(countPdfPages(ONE_PAGE_PDF)).toBe(1);
    expect(
      countPdfPages(pdfBytes("/Type /Page\n/Type/Page\n/Type /Pages /Count 2\n")),
    ).toBe(2);
  });

  test("returns null when structure is hidden (compressed object streams)", () => {
    expect(
      countPdfPages(pdfBytes("stream\n<binary object stream>\nendstream")),
    ).toBeNull();
  });
});

describe("looksLikePdf", () => {
  test("accepts the magic bytes and rejects a payload that only claims to be one", () => {
    expect(looksLikePdf(ONE_PAGE_PDF)).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode("not a pdf at all"))).toBe(false);
  });
});
