import type { Point } from "./protocol.js";

/**
 * Hold-to-straighten: a pen stroke that pauses at its end turns into a straight
 * line from its first point to the hold point. Distances are given in screen
 * pixels and converted with the current zoom, so the gesture feels the same at
 * any zoom level.
 */
export const LINE_HOLD_MS = 450;
/** Pen jitter allowed while holding still. */
export const LINE_HOLD_RADIUS_PX = 5;
/** Shorter strokes (dots, taps) never become lines. */
export const LINE_MIN_LENGTH_PX = 20;

export class HoldDetector {
  private start: Point | null = null;
  private anchor: Point | null = null;
  private since = 0;

  begin(point: Point, now: number): void {
    this.start = point;
    this.anchor = point;
    this.since = now;
  }

  /** Track the pen; returns true when it left the hold radius (hold restarts). */
  move(point: Point, now: number, pixelsPerUnit: number): boolean {
    if (!this.anchor) return false;
    const moved = Math.hypot(point.x - this.anchor.x, point.y - this.anchor.y) * pixelsPerUnit > LINE_HOLD_RADIUS_PX;
    if (moved) {
      this.anchor = point;
      this.since = now;
    }
    return moved;
  }

  /** The point where the pen has rested long enough, far from the start; else null. */
  held(now: number, pixelsPerUnit: number): Point | null {
    if (!this.start || !this.anchor || now - this.since < LINE_HOLD_MS) return null;
    const length = Math.hypot(this.anchor.x - this.start.x, this.anchor.y - this.start.y) * pixelsPerUnit;
    return length >= LINE_MIN_LENGTH_PX ? this.anchor : null;
  }

  /** Milliseconds until `held` can first succeed for the current anchor. */
  remaining(now: number): number {
    return Math.max(0, this.since + LINE_HOLD_MS - now);
  }

  reset(): void {
    this.start = null;
    this.anchor = null;
  }
}

/**
 * The two points of a straight line replacing a freehand stroke. Both ends use
 * the stroke's mean pressure so the line has an even width.
 */
export function straightLine(freehand: Point[], end: { x: number; y: number }): [Point, Point] {
  const first = freehand[0];
  if (!first) throw new Error("A straight line needs a start point.");
  const pressure = freehand.reduce((sum, point) => sum + point.pressure, 0) / freehand.length;
  return [{ x: first.x, y: first.y, pressure }, { x: end.x, y: end.y, pressure }];
}
