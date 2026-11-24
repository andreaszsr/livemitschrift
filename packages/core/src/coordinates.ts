import type { PageSize, Point } from "./protocol.js";

interface CanvasBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function toDocumentPoint(
  clientX: number,
  clientY: number,
  pressure: number,
  bounds: CanvasBounds,
  page: PageSize,
): Point {
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("The canvas must have a positive size.");
  }
  // Client coordinates and the bounding rectangle share a viewport origin.
  // Removing that offset before scaling also handles a scrolled document.
  return {
    x: Math.max(0, Math.min(page.width, (clientX - bounds.left) * page.width / bounds.width)),
    y: Math.max(0, Math.min(page.height, (clientY - bounds.top) * page.height / bounds.height)),
    pressure: Math.max(0, Math.min(1, pressure)),
  };
}

export function pressureWidth(baseWidth: number, pressure: number): number {
  return baseWidth * (0.35 + 0.65 * pressure);
}
