import { toDocumentPoint } from "./coordinates.js";
import type { PageSize, Point } from "./protocol.js";

export interface InputObservation {
  source?: "pointer" | "appkit";
  pointerType: string;
  pressure: number;
  button: number;
  buttons: number;
  phase: string;
  sampleCount: number;
  coalesced: boolean;
  inContact: boolean;
  eraser: boolean;
  timestamp?: number;
  sequence?: number;
  sentAt?: number;
  queueDelayMs?: number;
  mouseCoalescingEnabled?: boolean;
}

export interface InputHandlers {
  enabled(): boolean;
  start(point: Point): void;
  points(points: Point[]): void;
  end(): void;
  observe?(observation: InputObservation): void;
  processed?(milliseconds: number): void;
  temporaryTool?(tool: 'eraser' | null): void;
}

export class PenInput {
  private pointerId: number | null = null;
  private lastPoint: Point | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly page: PageSize,
    private readonly handlers: InputHandlers,
    private readonly mapPoint?: (x: number, y: number, pressure: number) => Point,
  ) {
    canvas.addEventListener("pointerdown", (event) => this.start(event));
    canvas.addEventListener("pointermove", (event) => this.move(event));
    canvas.addEventListener("pointerup", (event) => {
      // Pen-up commonly reports zero pressure; keep the last contact pressure.
      this.move(event, true);
      if (event.pointerId === this.pointerId) this.finish();
    });
    for (const name of ["pointercancel", "lostpointercapture"] as const) {
      canvas.addEventListener(name, (event) => {
        this.observe(event, 1);
        if (event.pointerId === this.pointerId) this.finish();
      });
    }
    window.addEventListener("blur", () => this.finish());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.finish();
    });
  }

  finish(): void {
    if (this.pointerId === null) return;
    const pointerId = this.pointerId;
    this.pointerId = null;
    this.lastPoint = null;
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.handlers.end();
  }

  private point(event: PointerEvent, releasing = false): Point {
    const pressure = event.pointerType === "pen"
      ? releasing ? this.lastPoint?.pressure ?? 0.5 : event.pressure
      : 0.5;
    if (this.mapPoint) return this.mapPoint(event.clientX, event.clientY, pressure);
    return toDocumentPoint(event.clientX, event.clientY, pressure,
      this.canvas.getBoundingClientRect(), this.page);
  }

  private start(event: PointerEvent): void {
    this.observe(event, 1);
    if (!this.handlers.enabled() || this.pointerId !== null || !event.isPrimary
      || event.button !== 0 || event.pointerType === "touch") return;
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.lastPoint = this.point(event);
    this.canvas.setPointerCapture(event.pointerId);
    this.handlers.start(this.lastPoint);
  }

  private move(event: PointerEvent, releasing = false): void {
    const coalesced = !releasing && typeof event.getCoalescedEvents === "function";
    const samples = coalesced ? event.getCoalescedEvents() : [];
    this.observe(event, samples.length || 1);
    if (event.pointerId !== this.pointerId) return;
    // The captured pointer ends on up/cancel/capture loss. The buttons bitmask
    // alone is not a reliable cancellation signal for generated input events.
    const points: Point[] = [];
    for (const sample of samples.length ? samples : [event]) {
      const point = this.point(sample, releasing);
      if (point.x === this.lastPoint?.x && point.y === this.lastPoint.y
        && point.pressure === this.lastPoint.pressure) continue;
      points.push(point);
      this.lastPoint = point;
    }
    if (points.length) this.handlers.points(points);
  }

  private observe(event: PointerEvent, sampleCount: number): void {
    this.handlers.observe?.({
      pointerType: event.pointerType,
      pressure: event.pressure,
      button: event.button,
      buttons: event.buttons,
      phase: event.type,
      sampleCount,
      coalesced: typeof event.getCoalescedEvents === "function",
      inContact: event.type === "pointerdown"
        || (event.type === "pointermove" && this.pointerId === event.pointerId),
      eraser: event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) !== 0),
    });
  }
}
