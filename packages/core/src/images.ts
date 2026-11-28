/**
 * Images placed on a notebook page. The bytes live in a content-addressed
 * asset (SHA-256 of the file); the page only stores the placement in document
 * coordinates (page width 1200). Images lie above the PDF background and
 * below the ink, newest on top.
 */
export interface PageImage {
  id: string;
  /** Lowercase hex SHA-256 of the PNG or JPEG file. */
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Shares the page's order counter with strokes; higher is drawn later. */
  order: number;
}

export const PAGE_WIDTH_UNITS = 1200;
export const MAX_PAGE_IMAGES = 50;
export const MAX_IMAGE_BYTES = 10_000_000;
/** Longest side of a stored image file in pixels (files are downscaled on insertion). */
export const MAX_IMAGE_SIDE = 2400;
/** Smallest placed side in document units, so an image stays selectable. */
export const MIN_IMAGE_SIZE = 12;

const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function validAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function validPageImage(value: unknown, pageHeight: number): value is PageImage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  // A tolerance of a thousandth of a unit absorbs floating point rounding at the page edge.
  return typeof image.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(image.id) && validAssetId(image.assetId)
    && number(image.x) && number(image.y) && number(image.width) && number(image.height)
    && image.x >= 0 && image.y >= 0 && image.width >= MIN_IMAGE_SIZE && image.height >= MIN_IMAGE_SIZE
    && image.x + image.width <= PAGE_WIDTH_UNITS + 1e-3 && image.y + image.height <= pageHeight + 1e-3
    && Number.isSafeInteger(image.order) && (image.order as number) >= 0;
}

/**
 * Initial placement of an image with the given pixel size: centred in the
 * visible part of the page, at most 60 % of the page width and of the visible
 * height, never upscaled beyond one document unit per pixel.
 */
export function placeImage(pixelWidth: number, pixelHeight: number, visibleTop: number, visibleHeight: number): {x: number; y: number; width: number; height: number} {
  const scale = Math.min(1, PAGE_WIDTH_UNITS * 0.6 / pixelWidth, Math.max(MIN_IMAGE_SIZE, visibleHeight * 0.6) / pixelHeight);
  const width = Math.max(MIN_IMAGE_SIZE, pixelWidth * scale), height = Math.max(MIN_IMAGE_SIZE, pixelHeight * scale);
  return {x: (PAGE_WIDTH_UNITS - width) / 2, y: Math.max(0, visibleTop + (visibleHeight - height) / 2), width, height};
}

/** Move an image by an offset, keeping it inside the page width and below the top edge. */
export function moveImage<T extends {x: number; y: number; width: number}>(image: T, dx: number, dy: number): T {
  return {...image, x: Math.min(PAGE_WIDTH_UNITS - image.width, Math.max(0, image.x + dx)), y: Math.max(0, image.y + dy)};
}

export type ImageCorner = "nw" | "ne" | "sw" | "se";

/**
 * Proportional resize by dragging one corner to `point`; the opposite corner
 * stays fixed. The new size follows the pointer's larger relative change and
 * is clamped to the page width and the minimal size.
 */
export function resizeImage<T extends {x: number; y: number; width: number; height: number}>(image: T, corner: ImageCorner, point: {x: number; y: number}): T {
  const ratio = image.width / image.height;
  const anchorX = corner === "nw" || corner === "sw" ? image.x + image.width : image.x;
  const anchorY = corner === "nw" || corner === "ne" ? image.y + image.height : image.y;
  const towardsLeft = corner === "nw" || corner === "sw", towardsTop = corner === "nw" || corner === "ne";
  let width = Math.max(Math.abs(point.x - anchorX), Math.abs(point.y - anchorY) * ratio);
  // Room between the fixed corner and the page edges (left/right, top).
  const roomX = towardsLeft ? anchorX : PAGE_WIDTH_UNITS - anchorX;
  const roomY = towardsTop ? anchorY : Infinity;
  width = Math.min(width, roomX, roomY * ratio);
  width = Math.max(width, MIN_IMAGE_SIZE * Math.max(1, ratio));
  const height = width / ratio;
  return {...image, width, height, x: towardsLeft ? anchorX - width : anchorX, y: towardsTop ? anchorY - height : anchorY};
}

/** Topmost image at a document point (images are drawn in ascending order). */
export function imageAt<T extends PageImage>(images: readonly T[], point: {x: number; y: number}): T | null {
  let found: T | null = null;
  for (const image of images)
    if (point.x >= image.x && point.x <= image.x + image.width && point.y >= image.y && point.y <= image.y + image.height
      && (!found || image.order > found.order)) found = image;
  return found;
}
