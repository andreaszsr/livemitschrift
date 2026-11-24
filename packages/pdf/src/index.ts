import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { MAX_PDF_BYTES } from "@livemitschrift/core";

export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_BYTES) throw new Error("Die PDF darf höchstens 50 MB groß sein.");
  const base = new URL("/pdfjs/", window.location.href).href;
  GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
  const task = getDocument({
    // PDF.js may transfer ownership to a worker. Keep the original available
    // for local storage and network publication.
    data: bytes.slice(), cMapUrl: `${base}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/`,
  });
  try {
    const document = await task.promise;
    if (document.numPages > 1000) throw new Error("Die PDF darf höchstens 1000 Seiten enthalten.");
    return document;
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

export { NotebookPdfRenderer } from "./notebook.js";
export { PageThumbnails } from "./thumbnails.js";
