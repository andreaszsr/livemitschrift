import { pressureWidth } from './coordinates.js';
import { HIGHLIGHTER_OPACITY } from './protocol.js';
import type { Point, Stroke } from './protocol.js';

/**
 * Marker ink is one translucent path with constant width. Stroking a single
 * path blends each pixel once, so self-overlaps do not darken. Incremental
 * live segments (`from > 0`) use butt caps to keep joint overlap small; callers
 * redraw the page once the marker stroke ends to remove any remaining seams.
 */
function drawHighlighter(context: CanvasRenderingContext2D, stroke: Stroke, from: number): void {
  const start = Math.max(0, from - 1), points = stroke.points;
  if (!points[start]) return;
  context.save();
  context.globalAlpha = HIGHLIGHTER_OPACITY;
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.lineJoin = 'round';
  context.lineCap = from === 0 ? 'round' : 'butt';
  context.beginPath();
  context.moveTo(points[start]!.x, points[start]!.y);
  // A single point still produces a round dot through the zero-length segment.
  if (points.length === 1) context.lineTo(points[0]!.x, points[0]!.y);
  for (let index = start + 1; index < points.length; index++) context.lineTo(points[index]!.x, points[index]!.y);
  context.stroke();
  context.restore();
}

/** Shared vector appearance for the writing canvas and small page previews. */
export function drawStroke(
  context: CanvasRenderingContext2D,
  stroke: Stroke,
  from = 0,
  minY = -Infinity,
  maxY = Infinity,
): void {
  if (stroke.highlighter) { drawHighlighter(context, stroke, from); return; }
  context.fillStyle = stroke.color;
  context.strokeStyle = stroke.color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const dot = (point: Point): void => {
    context.beginPath();
    context.arc(point.x, point.y, pressureWidth(stroke.width, point.pressure) / 2, 0, Math.PI * 2);
    context.fill();
  };
  if (from === 0 && stroke.points[0]) dot(stroke.points[0]);
  for (let index = Math.max(1, from); index < stroke.points.length; index++) {
    const previous = stroke.points[index - 1]!, current = stroke.points[index]!;
    if (Math.max(previous.y, current.y) + stroke.width < minY || Math.min(previous.y, current.y) - stroke.width > maxY) continue;
    context.lineWidth = pressureWidth(stroke.width, (previous.pressure + current.pressure) / 2);
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(current.x, current.y);
    context.stroke();
    dot(current);
  }
}
