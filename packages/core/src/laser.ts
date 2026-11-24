import type { PageSize } from "./protocol.js";

const SVG = "http://www.w3.org/2000/svg";
/** Trail length and the time a released pointer remains visible. */
const TRAIL_MS = 450;
const FADE_MS = 900;

interface TrailPoint { x: number; y: number; time: number }

/**
 * A transient laser pointer drawn as SVG in document coordinates over the
 * paper. The viewBox equals the page size, so zoom and scrolling need no extra
 * transformation; nothing here is stored or added to the ink document.
 */
export class LaserPointer {
  private readonly svg: SVGSVGElement;
  private readonly trail: SVGPolylineElement;
  private readonly glow: SVGCircleElement;
  private readonly head: SVGCircleElement;
  private points: TrailPoint[] = [];
  private active = false;
  private releasedAt = 0;
  private frame: number | null = null;

  constructor(paper: HTMLElement, private readonly page: PageSize) {
    this.svg = document.createElementNS(SVG, "svg");
    this.svg.classList.add("laser-pointer");
    this.svg.setAttribute("aria-hidden", "true");
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.trail = document.createElementNS(SVG, "polyline");
    this.trail.setAttribute("fill", "none");
    this.trail.setAttribute("stroke", "#ff2a1f");
    this.trail.setAttribute("stroke-width", "5");
    this.trail.setAttribute("stroke-linecap", "round");
    this.trail.setAttribute("stroke-linejoin", "round");
    this.trail.setAttribute("stroke-opacity", "0.45");
    this.glow = document.createElementNS(SVG, "circle");
    this.glow.setAttribute("r", "16");
    this.glow.setAttribute("fill", "#ff2a1f");
    this.glow.setAttribute("fill-opacity", "0.25");
    this.head = document.createElementNS(SVG, "circle");
    this.head.setAttribute("r", "7");
    this.head.setAttribute("fill", "#ff2a1f");
    this.svg.append(this.trail, this.glow, this.head);
    this.svg.style.display = "none";
    paper.append(this.svg);
  }

  /** Show the pointer at a document point, or start fading it out with `null`. */
  move(point: { x: number; y: number } | null): void {
    const now = performance.now();
    if (point) {
      this.active = true;
      this.points.push({ x: point.x, y: point.y, time: now });
    } else if (this.active) {
      this.active = false;
      this.releasedAt = now;
    }
    this.schedule();
  }

  clear(): void {
    this.points = []; this.active = false; this.releasedAt = 0;
    this.svg.style.display = "none";
  }

  private schedule(): void {
    if (this.frame === null) this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); });
  }

  private render(): void {
    const now = performance.now();
    this.points = this.points.filter(point => now - point.time <= TRAIL_MS || point === this.points.at(-1));
    const last = this.points.at(-1);
    const fade = this.active ? 1 : Math.max(0, 1 - (now - this.releasedAt) / FADE_MS);
    if (!last || fade <= 0) { this.clear(); return; }
    this.svg.style.display = "";
    this.svg.setAttribute("viewBox", `0 0 ${this.page.width} ${this.page.height}`);
    this.svg.style.opacity = String(fade);
    this.trail.setAttribute("points", this.points.map(point => `${point.x},${point.y}`).join(" "));
    for (const circle of [this.glow, this.head]) {
      circle.setAttribute("cx", String(last.x));
      circle.setAttribute("cy", String(last.y));
    }
    // Keep animating while the trail shortens or the released pointer fades.
    if (this.points.length > 1 || !this.active) this.schedule();
  }
}
