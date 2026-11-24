import { toDocumentPoint } from "@livemitschrift/core";
import type { InputHandlers, PageSize, Point } from "@livemitschrift/core";

export interface NativeSample {
  phase: "down" | "up" | "move" | "drag" | "leave";
  pointerType: "pen" | "mouse";
  x: number;
  y: number;
  pressure: number;
  buttons: number;
  button: number;
  eraser: boolean;
  timestamp?: number;
  sequence?: number;
  sentAt?: number;
  queueDelayMs?: number;
  mouseCoalescingEnabled?: boolean;
}

export function nativeInputAvailable(): boolean {
  return (window as Window & { __LIVEMITSCHRIFT_NATIVE_INPUT__?: boolean }).__LIVEMITSCHRIFT_NATIVE_INPUT__ === true;
}

function validSample(value: unknown): value is NativeSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as NativeSample;
  return ["down", "up", "move", "drag", "leave"].includes(sample.phase)
    && ["pen", "mouse"].includes(sample.pointerType)
    && [sample.x, sample.y, sample.pressure, sample.button, sample.buttons].every(Number.isFinite)
    && sample.pressure >= 0 && sample.pressure <= 1
    && Number.isSafeInteger(sample.buttons) && sample.buttons >= 0
    && Number.isSafeInteger(sample.button) && typeof sample.eraser === "boolean"
    && [sample.timestamp, sample.sequence, sample.sentAt, sample.queueDelayMs].every(value => value === undefined || (Number.isFinite(value) && value >= 0))
    && (sample.sequence === undefined || Number.isSafeInteger(sample.sequence))
    && (sample.mouseCoalescingEnabled === undefined || typeof sample.mouseCoalescingEnabled === 'boolean');
}

/** Convert AppKit samples to the same document-space callbacks as Pointer Events. */
export class NativePenInput {
  private active: NativeSample["pointerType"] | null = null;
  private blocked: NativeSample["pointerType"] | null = null;
  private lastPoint: Point | null = null;
  private temporaryEraser = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewport: HTMLElement,
    private readonly page: PageSize,
    private readonly handlers: InputHandlers,
    private readonly mapPoint?: (x: number, y: number, pressure: number) => Point,
  ) {
    window.addEventListener("livemitschrift-native-input", (event) => {
      this.accept((event as CustomEvent<unknown>).detail);
    });
    window.addEventListener("blur", () => this.finish());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.finish();
    });
    canvas.addEventListener('contextmenu', event => event.preventDefault());
  }

  finish(): void {
    // View/focus changes must wait for physical release before accepting another
    // pen stroke, even if the driver hasn't generated its mouse-down yet.
    if (this.active) this.blocked = this.active;
    this.end();
    this.setTemporaryEraser(false);
  }

  accept(value: unknown): void {
    const start = performance.now();
    try { this.handle(value); }
    finally { this.handlers.processed?.(performance.now() - start); }
  }

  private handle(value: unknown): void {
    if (!validSample(value)) {
      this.finish();
      throw new Error("Invalid native tablet sample.");
    }
    const sample = value;
    const temporaryEraser = sample.pointerType === 'pen' && ((sample.buttons & 2) !== 0 || sample.eraser) && !!this.handlers.temporaryTool;
    const contact = sample.pointerType === "pen"
      // Native pressure reveals light contact before the driver's mouse-click
      // threshold. Never substitute 0.5 for a tablet's reported pressure.
      ? sample.pressure > 0 && (!sample.eraser || !!this.handlers.temporaryTool) && (sample.buttons & ~(this.handlers.temporaryTool ? 3 : 1)) === 0
      : (sample.phase === "down" && sample.button === 0)
        || (this.active === "mouse" && sample.phase === "drag");
    this.handlers.observe?.({
      source: "appkit", pointerType: sample.pointerType, pressure: sample.pressure,
      button: sample.button, buttons: sample.buttons, phase: `AppKit ${sample.phase}`,
      sampleCount: 1, coalesced: false, inContact: contact, eraser: sample.eraser,
      timestamp: sample.timestamp, sequence: sample.sequence, sentAt: sample.sentAt,
      queueDelayMs: sample.queueDelayMs, mouseCoalescingEnabled: sample.mouseCoalescingEnabled,
    });
    if (sample.phase === "leave") {
      if (this.active === "pen") this.end();
      if (this.blocked === "pen") this.blocked = null;
      this.setTemporaryEraser(false);
      return;
    }
    if (this.active && this.active !== sample.pointerType) return;
    if (this.blocked === sample.pointerType) {
      if (!contact || (sample.pointerType === "mouse" && sample.phase === "down")) this.blocked = null;
      else {if (sample.pointerType === 'pen' && !temporaryEraser) this.setTemporaryEraser(false); return;}
    }
    if (!this.handlers.enabled()) {
      this.finish();
      return;
    }
    if (sample.pointerType === 'pen') this.setTemporaryEraser(temporaryEraser);
    else if (sample.phase === 'down' && sample.button === 0) this.setTemporaryEraser(false);
    if (!contact) {
      if (this.active) {
        this.append(sample, true);
        this.end();
      }
      return;
    }
    if (!this.active) {
      if (!this.inside(sample)) {
        this.blocked = sample.pointerType;
        return;
      }
      this.active = sample.pointerType;
      this.lastPoint = this.point(sample);
      this.handlers.start(this.lastPoint);
    } else this.append(sample);
  }

  private inside(sample: NativeSample): boolean {
    const canvas = this.canvas.getBoundingClientRect();
    const clip = this.viewport.getBoundingClientRect();
    // Native events also reach the app while a floating control covers paper.
    // A fresh contact must hit the actual ink canvas, not a toolbar or drawer.
    if (typeof document.elementFromPoint === "function") {
      const target = document.elementFromPoint(sample.x, sample.y);
      if (target !== this.canvas) return false;
    }
    // The canvas can extend underneath the toolbar after scrolling. Both the
    // page rectangle and its visible scroll container must contain a new stroke.
    return sample.x >= Math.max(canvas.left, clip.left)
      && sample.x < Math.min(canvas.right, clip.right)
      && sample.y >= Math.max(canvas.top, clip.top)
      && sample.y < Math.min(canvas.bottom, clip.bottom);
  }

  private point(sample: NativeSample, releasing = false): Point {
    const pressure = sample.pointerType === "pen"
      ? releasing ? this.lastPoint?.pressure ?? sample.pressure : sample.pressure : 0.5;
    if (this.mapPoint) return this.mapPoint(sample.x, sample.y, pressure);
    return toDocumentPoint(sample.x, sample.y, pressure,
      this.canvas.getBoundingClientRect(), this.page);
  }

  private append(sample: NativeSample, releasing = false): void {
    const point = this.point(sample, releasing);
    if (point.x === this.lastPoint?.x && point.y === this.lastPoint.y
      && point.pressure === this.lastPoint.pressure) return;
    this.lastPoint = point;
    this.handlers.points([point]);
  }

  private end(): void {
    if (!this.active) return;
    this.active = null;
    this.lastPoint = null;
    this.handlers.end();
  }

  private setTemporaryEraser(pressed: boolean): void {
    if (this.temporaryEraser === pressed) return;
    // Finish in the previous tool before switching. Never connect pen geometry
    // to an eraser gesture, or restore the pen across the erased path.
    this.end();
    this.temporaryEraser = pressed;
    this.handlers.temporaryTool?.(pressed ? 'eraser' : null);
  }
}
