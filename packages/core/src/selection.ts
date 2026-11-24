import type { PageSize, Stroke } from "./protocol.js";

export interface Vector { x: number; y: number }
export interface Bounds { left: number; top: number; right: number; bottom: number }

/** Even-odd ray casting in document coordinates; the polygon closes implicitly. */
export function pointInPolygon(point: Vector, polygon: Vector[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!, b = polygon[previous]!;
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * A stroke belongs to the lasso when most of its points lie inside. This keeps
 * long strokes that merely touch the lasso out, and tolerates a loosely drawn loop.
 */
export function lassoSelection(strokes: Iterable<Stroke>, polygon: Vector[], share = 0.5): Stroke[] {
  if (polygon.length < 3) return [];
  return [...strokes].filter(stroke => stroke.complete && stroke.points.length > 0
    && stroke.points.filter(point => pointInPolygon(point, polygon)).length / stroke.points.length >= share);
}

/** Bounding box including half the stroke width, so the frame encloses visible ink. */
export function strokeBounds(strokes: Stroke[]): Bounds | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const stroke of strokes) for (const point of stroke.points) {
    const half = stroke.width / 2;
    left = Math.min(left, point.x - half); right = Math.max(right, point.x + half);
    top = Math.min(top, point.y - half); bottom = Math.max(bottom, point.y + half);
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null;
}

/**
 * Limit a translation so every point stays on the page (x in [0, width],
 * y in [0, height]). Points, not the widened bounds, are what storage validates.
 */
export function clampOffset(strokes: Stroke[], offset: Vector, page: PageSize): Vector {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const stroke of strokes) for (const point of stroke.points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0 };
  return {
    x: Math.max(-minX, Math.min(page.width - maxX, offset.x)),
    y: Math.max(-minY, Math.min(page.height - maxY, offset.y)),
  };
}

/** Copies moved by an (already clamped) offset; identities and order are kept. */
export function translateStrokes(strokes: Stroke[], offset: Vector): Stroke[] {
  return strokes.map(stroke => ({
    ...structuredClone(stroke),
    points: stroke.points.map(point => ({ ...point, x: point.x + offset.x, y: point.y + offset.y })),
  }));
}

/**
 * Pasted copies receive new identities and consecutive drawing orders, keep
 * their relative order and style, and are clamped onto the target page.
 */
export function pasteStrokes(strokes: Stroke[], offset: Vector, page: PageSize, firstOrder: number, nextId: () => string): Stroke[] {
  const ordered = [...strokes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return translateStrokes(ordered, clampOffset(ordered, offset, page))
    .map((stroke, index) => ({ ...stroke, id: nextId(), order: firstOrder + index, complete: true }));
}
