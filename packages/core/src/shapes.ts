import type { Point } from "./protocol.js";

/**
 * Geometric shapes as ordinary polylines in document coordinates, so that
 * rendering, erasing, undo, synchronization and PDF export treat them like
 * handwriting. All shapes use one constant pressure (uniform width).
 */
export type ShapeKind = "rectangle" | "circle" | "quadrant" | "cross";
export const SHAPE_KINDS: readonly ShapeKind[] = ["rectangle", "circle", "quadrant", "cross"];
export const SHAPE_PRESSURE = 0.5;

/** Arrow head and tick sizes in document units (1200 units = page width). */
const ARROW_LENGTH = 16, ARROW_HALF_WIDTH = 7, TICK_HALF_LENGTH = 6;
/** Circles get one vertex per this many document units of circumference. */
const CIRCLE_SEGMENT = 6, CIRCLE_MIN_VERTICES = 24, CIRCLE_MAX_VERTICES = 240;

const at = (x: number, y: number): Point => ({ x, y, pressure: SHAPE_PRESSURE });

/** Nearest grid point; grid lines lie on multiples of `spacing` from the page origin. */
export function snapToGrid(point: { x: number; y: number }, spacing: number): { x: number; y: number } {
  return { x: Math.round(point.x / spacing) * spacing, y: Math.round(point.y / spacing) * spacing };
}

export interface ShapeOptions {
  /** Distance between axis ticks (the grid spacing). */
  tickSpacing: number;
  /** When set, defining points snap to this grid spacing. */
  snap?: number | null;
}

/**
 * Strokes for a shape dragged from `start` to `end`:
 * - rectangle: corner to corner;
 * - circle: centre at `start`, radius = drag distance;
 * - quadrant: origin at `start`, axes towards `end` (one quadrant);
 * - cross: axes through the centre of the dragged box (four quadrants).
 * With snapping, corners, centre, radius, origin and axis ends lie on the grid.
 */
export function shapeStrokes(kind: ShapeKind, start: { x: number; y: number }, end: { x: number; y: number }, options: ShapeOptions): Point[][] {
  const snap = options.snap ?? null;
  const fit = (point: { x: number; y: number }): { x: number; y: number } => (snap ? snapToGrid(point, snap) : point);
  switch (kind) {
    case "rectangle": {
      const a = fit(start), b = fit(end);
      return [[at(a.x, a.y), at(b.x, a.y), at(b.x, b.y), at(a.x, b.y), at(a.x, a.y)]];
    }
    case "circle": {
      const centre = fit(start);
      let radius = Math.hypot(end.x - centre.x, end.y - centre.y);
      if (snap) radius = Math.round(radius / snap) * snap;
      return radius > 0 ? [circle(centre, radius)] : [];
    }
    case "quadrant": {
      const origin = fit(start), tip = fit(end);
      return [
        axis(origin, { x: tip.x, y: origin.y }, origin, options.tickSpacing),
        axis(origin, { x: origin.x, y: tip.y }, origin, options.tickSpacing),
      ].filter(stroke => stroke.length > 1);
    }
    case "cross": {
      // Centre and half sizes snap separately, so the axes lie on grid lines.
      let centre = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      let halfWidth = Math.abs(end.x - start.x) / 2, halfHeight = Math.abs(end.y - start.y) / 2;
      if (snap) {
        centre = snapToGrid(centre, snap);
        halfWidth = Math.round(halfWidth / snap) * snap;
        halfHeight = Math.round(halfHeight / snap) * snap;
      }
      return [
        axis({ x: centre.x - halfWidth, y: centre.y }, { x: centre.x + halfWidth, y: centre.y }, centre, options.tickSpacing),
        // The vertical axis points up: from the bottom end to the top end.
        axis({ x: centre.x, y: centre.y + halfHeight }, { x: centre.x, y: centre.y - halfHeight }, centre, options.tickSpacing),
      ].filter(stroke => stroke.length > 1);
    }
  }
}

function circle(centre: { x: number; y: number }, radius: number): Point[] {
  const vertices = Math.min(CIRCLE_MAX_VERTICES, Math.max(CIRCLE_MIN_VERTICES, Math.ceil(2 * Math.PI * radius / CIRCLE_SEGMENT)));
  return Array.from({ length: vertices + 1 }, (_, index) => {
    const angle = 2 * Math.PI * index / vertices;
    return at(centre.x + radius * Math.cos(angle), centre.y + radius * Math.sin(angle));
  });
}

/**
 * One axis as a single polyline from `tail` to the arrow `tip`. Ticks lie at
 * multiples of `spacing` from `origin` (on the axis) and are drawn as short
 * perpendicular detours that return to the axis; the arrow head is a detour
 * at the tip. Retracing a segment is invisible with uniform width.
 */
function axis(tail: { x: number; y: number }, tip: { x: number; y: number }, origin: { x: number; y: number }, spacing: number): Point[] {
  const length = Math.hypot(tip.x - tail.x, tip.y - tail.y);
  if (length === 0) return [];
  const ux = (tip.x - tail.x) / length, uy = (tip.y - tail.y) / length, nx = -uy, ny = ux;
  const along = (distance: number): { x: number; y: number } => ({ x: tail.x + ux * distance, y: tail.y + uy * distance });
  const points: Point[] = [at(tail.x, tail.y)];
  if (spacing > 0) {
    // Origin position on the axis; ticks keep clear of the origin itself and the arrow head.
    const originAt = (origin.x - tail.x) * ux + (origin.y - tail.y) * uy;
    const first = Math.ceil((0 - originAt) / spacing), last = Math.floor((length - ARROW_LENGTH - originAt) / spacing);
    for (let index = first; index <= last; index++) {
      const distance = originAt + index * spacing;
      if (index === 0 || distance <= 0) continue;
      const point = along(distance);
      points.push(at(point.x, point.y),
        at(point.x + nx * TICK_HALF_LENGTH, point.y + ny * TICK_HALF_LENGTH),
        at(point.x - nx * TICK_HALF_LENGTH, point.y - ny * TICK_HALF_LENGTH),
        at(point.x, point.y));
    }
  }
  const head = Math.min(ARROW_LENGTH, length / 2), base = along(length - head), half = Math.min(ARROW_HALF_WIDTH, head / 2);
  points.push(at(tip.x, tip.y),
    at(base.x + nx * half, base.y + ny * half),
    at(tip.x, tip.y),
    at(base.x - nx * half, base.y - ny * half));
  return points;
}
