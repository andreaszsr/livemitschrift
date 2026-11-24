import type { PageSize, PdfBackground } from "./protocol.js";

export function validPdfBackground(value: unknown, maximumPage = 1): value is PdfBackground {
  if (!value || typeof value !== "object") return false;
  const pdf = value as PdfBackground;
  return typeof pdf.assetId === "string" && /^[a-f0-9]{64}$/.test(pdf.assetId)
    && typeof pdf.name === "string" && pdf.name.length > 0 && [...pdf.name].length <= 200
    && Number.isInteger(pdf.pageNumber) && pdf.pageNumber >= 1 && pdf.pageNumber <= maximumPage
    && typeof pdf.width === "number" && Number.isFinite(pdf.width) && pdf.width > 0
    && typeof pdf.height === "number" && Number.isFinite(pdf.height) && pdf.height > 0
    && (pdf.fitHeight == null || (Number.isFinite(pdf.fitHeight) && pdf.fitHeight > 0 && pdf.fitHeight <= 1_000_000_000));
}

/** A fixed background height remains unchanged when the writing space grows. */
export function notebookPdfPlacement(pdf: PdfBackground): ReturnType<typeof fitPdfToPage> {
  return fitPdfToPage({width: 1200, height: pdf.fitHeight ?? 1200 * pdf.height / pdf.width}, pdf);
}

/** Place the PDF at the top, preserving aspect ratio and document coordinates. */
export function fitPdfToPage(page: PageSize, pdf: PageSize): { x: number; y: number; width: number; height: number; scale: number } {
  if (![page.width, page.height, pdf.width, pdf.height].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error("Invalid PDF or document dimensions.");
  }
  const scale = Math.min(page.width / pdf.width, page.height / pdf.height);
  const width = pdf.width * scale;
  return { x: (page.width - width) / 2, y: 0, width, height: pdf.height * scale, scale };
}
