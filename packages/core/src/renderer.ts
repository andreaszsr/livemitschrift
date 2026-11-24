import { drawStroke } from "./stroke-rendering.js";
import type { InkDocument } from "./document.js";
import type { PageSize, Stroke } from "./protocol.js";

export class InkRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly document: InkDocument,
    private readonly page: PageSize,
  ) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable.");
    this.context = context;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  private resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(bounds.width * pixelRatio));
    const height = Math.max(1, Math.round(bounds.height * pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.redraw();
    }
  }

  redraw(): void {
    this.context.resetTransform();
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.setTransform(this.canvas.width / this.page.width, 0,
      0, this.canvas.height / this.page.height, 0, 0);
    for (const stroke of this.document.strokes.values()) this.draw(stroke, 0);
  }

  draw(stroke: Stroke, from: number): void {
    drawStroke(this.context, stroke, from);
  }
}
