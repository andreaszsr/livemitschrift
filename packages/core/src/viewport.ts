import { drawStroke } from "./stroke-rendering.js";
import type { InkDocument } from "./document.js";
import type { PageSize, Point, Stroke } from "./protocol.js";
/** A viewport-sized bitmap over a tall document-space paper; no tall ink canvas. */
export class ViewportInkRenderer {
    private readonly context: CanvasRenderingContext2D;
    private readonly observer: ResizeObserver;
    private frame: number | null = null;
    private top = 0;
    private scale = 1;
    private lastY = -1;
    private bounds = new Map<string, {
        count: number;
        min: number;
        max: number;
    }>();
    constructor(private readonly canvas: HTMLCanvasElement, private readonly paper: HTMLElement, private readonly viewport: HTMLElement, private readonly document: InkDocument, private readonly page: PageSize, private readonly onView?: (y: number) => void) {
        const context = canvas.getContext("2d");
        if (!context)
            throw new Error("Canvas 2D is unavailable.");
        this.context = context;
        this.observer = new ResizeObserver(() => this.schedule());
        this.observer.observe(paper);
        this.observer.observe(viewport);
        viewport.addEventListener("scroll", () => this.schedule(), { passive: true });
        window.addEventListener("resize", () => this.schedule());
        this.redraw();
    }
    toPoint(x: number, y: number, pressure: number): Point {
        const rect = this.paper.getBoundingClientRect(), scale = rect.width / this.page.width;
        return { x: Math.max(0, Math.min(this.page.width, (x - rect.left) / scale)),
            y: Math.max(0, Math.min(this.page.height, (y - rect.top) / scale)), pressure: Math.max(0, Math.min(1, pressure)) };
    }
    get visibleY(): number { return this.top; }
    get pixelsPerUnit(): number { return this.scale; }
    invalidate(): void { this.bounds.clear(); this.redraw(); }
    private schedule(): void {
        if (this.frame === null)
            this.frame = requestAnimationFrame(() => { this.frame = null; this.redraw(); });
    }
    redraw(): void {
        const rect = this.paper.getBoundingClientRect(), clip = this.viewport.getBoundingClientRect();
        if (!rect.width || !clip.height)
            return;
        this.scale = rect.width / this.page.width;
        const offset = Math.max(0, clip.top - rect.top);
        this.top = offset / this.scale;
        const height = Math.max(1, Math.min(clip.bottom - Math.max(clip.top, rect.top), rect.height - offset));
        this.canvas.style.top = `${offset}px`;
        this.canvas.style.height = `${height}px`;
        const ratio = window.devicePixelRatio || 1, width = Math.max(1, Math.round(rect.width * ratio)), pixels = Math.max(1, Math.round(height * ratio));
        if (this.canvas.width !== width)
            this.canvas.width = width;
        if (this.canvas.height !== pixels)
            this.canvas.height = pixels;
        this.context.resetTransform();
        this.context.clearRect(0, 0, width, pixels);
        this.context.setTransform(width / this.page.width, 0, 0, width / this.page.width, 0, -this.top * width / this.page.width);
        for (const stroke of this.document.strokes.values()) {
            let bounds = this.bounds.get(stroke.id);
            if (!bounds || bounds.count > stroke.points.length)
                bounds = { count: 0, min: Infinity, max: -Infinity };
            for (let index = bounds.count; index < stroke.points.length; index++) {
                const y = stroke.points[index]!.y;
                bounds.min = Math.min(bounds.min, y);
                bounds.max = Math.max(bounds.max, y);
            }
            bounds.count = stroke.points.length;
            this.bounds.set(stroke.id, bounds);
            if (bounds.max + stroke.width >= this.top && bounds.min - stroke.width <= this.top + height / this.scale)
                this.draw(stroke, 0);
        }
        if (Math.abs(this.lastY - this.top) > .01) {
            this.lastY = this.top;
            this.onView?.(this.top);
        }
    }
    draw(stroke: Stroke, from: number): void {
        drawStroke(this.context, stroke, from, this.top, this.top + this.canvas.clientHeight / this.scale);
    }
}
