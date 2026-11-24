import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { notebookPdfPlacement } from "@livemitschrift/core";
import type { PdfBackground } from "@livemitschrift/core";
import { loadPdfDocument } from "./index.js";

interface AssetLoad {
  id: string;
  promise: Promise<PDFDocumentProxy>;
}

/** Only PDF-sized backgrounds are rasterized; writing space never enlarges them. */
export class NotebookPdfRenderer {
  private generation = 0;
  private task: RenderTask | null = null;
  private current: PdfBackground | null = null;
  private asset: AssetLoad | null = null;
  private requestedKey = "";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly read: (id: string, pageNumber: number) => Promise<Uint8Array>,
    private readonly onError: (error: unknown) => void,
    private readonly singlePageResources = false,
  ) {
    new ResizeObserver(() => { void this.render().catch(onError); }).observe(canvas.parentElement!);
  }

  async set(background: PdfBackground | null): Promise<void> {
    this.current = background;
    this.generation++;
    this.task?.cancel();
    this.requestedKey = "";
    this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.dataset.assetReady = "false";
    if (this.asset && this.asset.id !== (background ? this.resourceKey(background) : null)) {
      // A superseded load still owns a worker even when it has not resolved yet.
      void this.asset.promise.then(pdf => pdf.loadingTask.destroy()).catch(this.onError);
      this.asset = null;
    }
    if (!background) {
      this.canvas.style.height = "0px";
      return;
    }
    await this.render();
  }

  private resourceKey(background: PdfBackground): string {
    return this.singlePageResources ? `${background.assetId}/${background.pageNumber}` : background.assetId;
  }

  private async render(): Promise<void> {
    const background = this.current;
    if (!background) return;
    const width = this.canvas.parentElement!.getBoundingClientRect().width;
    if (!width) return;
    const ratio = window.devicePixelRatio || 1;
    const key = `${background.assetId}/${background.pageNumber}/${width}/${ratio}`;
    // Growing the paper changes its height, but does not change the PDF bitmap.
    if (key === this.requestedKey) return;
    this.requestedKey = key;
    const generation = ++this.generation;
    this.task?.cancel();
    this.canvas.dataset.renderState = "loading";
    try {
      this.asset ??= {id: this.resourceKey(background), promise: this.read(background.assetId, background.pageNumber).then(loadPdfDocument)};
      const pdf = await this.asset.promise;
      if (generation !== this.generation) return;
      const page = await pdf.getPage(this.singlePageResources ? 1 : background.pageNumber);
      if (generation !== this.generation) return;
      const native = page.getViewport({scale: 1}), placement = notebookPdfPlacement(background);
      this.canvas.style.height = `${width * placement.height / 1200}px`;
      // Cap pixel work on extreme page formats while retaining the CSS geometry.
      const pixelScale = Math.min(width * ratio / 1200, 8192 / 1200, 8192 / placement.height);
      const scale = placement.width * pixelScale / native.width;
      const viewport = page.getViewport({scale});
      const target = document.createElement("canvas");
      target.width = Math.max(1, Math.ceil(viewport.width));
      target.height = Math.max(1, Math.ceil(viewport.height));
      this.canvas.dataset.renderState = "rendering";
      const task = page.render({canvas: target, viewport});
      this.task = task;
      await task.promise;
      if (generation !== this.generation) return;
      this.canvas.width = Math.max(1, Math.ceil(1200 * pixelScale));
      this.canvas.height = target.height;
      this.canvas.getContext("2d")!.drawImage(target, placement.x * pixelScale, 0);
      this.canvas.dataset.assetReady = "true";
      this.canvas.dataset.renderState = "ready";
      this.task = null;
    } catch (error) {
      if (generation !== this.generation || (error instanceof Error && error.name === "RenderingCancelledException")) return;
      this.requestedKey = "";
      this.asset = null;
      this.canvas.dataset.renderState = "error";
      throw error;
    }
  }
}
