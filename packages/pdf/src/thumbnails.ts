import { drawStroke, notebookPdfPlacement } from '@livemitschrift/core';
import type { NotePage } from '@livemitschrift/core';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { loadPdfDocument } from './index.js';

/** Render only visible previews, serially, with one PDF worker per open picker. */
export class PageThumbnails {
  private readonly pages = new Map<HTMLCanvasElement, NotePage>();
  private readonly pending = new Set<HTMLCanvasElement>();
  private readonly observer: IntersectionObserver;
  private running = false;
  private disposed = false;
  private asset: {id: string; pdf: PDFDocumentProxy} | null = null;
  private task: RenderTask | null = null;

  constructor(
    root: HTMLElement,
    private readonly read: (id: string, pageNumber: number) => Promise<Uint8Array>,
    private readonly singlePageResources = false,
    private readonly preview?: (page: NotePage) => Promise<NotePage>,
  ) {
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const canvas = entry.target as HTMLCanvasElement;
        if (entry.isIntersecting) this.pending.add(canvas);
        else this.pending.delete(canvas);
      }
      void this.drain();
    }, {root, rootMargin: '100px'});
  }

  add(canvas: HTMLCanvasElement, page: NotePage): void {
    canvas.width = canvas.height = 1;
    canvas.title = 'Vorschau des oberen Seitenbereichs';
    this.pages.set(canvas, page);
    this.observer.observe(canvas);
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    this.pending.clear();
    this.task?.cancel();
    const asset = this.asset;
    this.asset = null;
    if (asset) void asset.pdf.loadingTask.destroy().catch(() => {});
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (this.pending.size && !this.disposed) {
        const canvas = this.pending.values().next().value!;
        this.pending.delete(canvas);
        this.observer.unobserve(canvas);
        try { await this.render(canvas, this.pages.get(canvas)!); }
        catch {
          // A broken preview must not prevent navigation or the other previews.
          if (!this.disposed) {canvas.dataset.previewReady = 'error'; canvas.title = 'Vorschau nicht verfügbar';}
        }
      }
    } finally {this.running = false;}
  }

  private async render(canvas: HTMLCanvasElement, page: NotePage): Promise<void> {
    if (this.preview) page = await this.preview(page);
    if (this.disposed) return;
    canvas.width = 256; canvas.height = 192;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    const height = Math.min(page.height, Math.max(900, page.background ? 1200 * page.background.height / page.background.width : 1600));
    const scale = Math.min(canvas.width / page.width, canvas.height / height);
    context.translate((canvas.width - page.width * scale) / 2, 0);
    context.scale(scale, scale);
    if (page.background) {
      const background = page.background;
      const resourceId = this.singlePageResources ? `${background.assetId}/${background.pageNumber}` : background.assetId;
      if (this.asset?.id !== resourceId) {
        if (this.asset) await this.asset.pdf.loadingTask.destroy();
        this.asset = null;
        const pdf = await loadPdfDocument(await this.read(background.assetId, background.pageNumber));
        if (this.disposed) {await pdf.loadingTask.destroy(); return;}
        this.asset = {id: resourceId, pdf};
      }
      const pdfPage = await this.asset.pdf.getPage(this.singlePageResources ? 1 : background.pageNumber);
      if (this.disposed) return;
      const native = pdfPage.getViewport({scale: 1});
      const placement = notebookPdfPlacement(background);
      const viewport = pdfPage.getViewport({scale: placement.width * scale / native.width});
      const bitmap = document.createElement('canvas');
      bitmap.width = Math.ceil(viewport.width); bitmap.height = Math.ceil(viewport.height);
      this.task = pdfPage.render({canvas: bitmap, viewport});
      await this.task.promise;
      if (this.disposed) return;
      context.drawImage(bitmap, placement.x, 0, placement.width, placement.height);
      pdfPage.cleanup();
    }
    for (const stroke of page.strokes) drawStroke(context, stroke, 0, 0, height);
    canvas.dataset.previewReady = 'true';
  }
}
