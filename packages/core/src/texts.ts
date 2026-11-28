/**
 * Typed text boxes on a notebook page. A box stores its top left corner and
 * width in document coordinates (page width 1200); its height follows from
 * the text layout (see text-layout.ts) and is never stored. Text boxes lie
 * above the ink. Plain text only; https/mailto URLs become links when shown.
 */
export type TextSize = "small" | "medium" | "large";
export const TEXT_SIZES: readonly TextSize[] = ["small", "medium", "large"];

export interface PageText {
  id: string;
  x: number;
  y: number;
  width: number;
  text: string;
  size: TextSize;
  color: string;
  /** Monospace, whitespace kept exactly, no automatic links. */
  code: boolean;
  /** Shares the page's order counter with strokes and images. */
  order: number;
}

export const MAX_PAGE_TEXTS = 50;
export const MAX_TEXT_LENGTH = 5000;
/** Narrowest box in document units, so a box stays selectable and readable. */
export const MIN_TEXT_WIDTH = 60;
/** Font size (em) in document units; 1200 units are 210 mm, so medium is about 14 pt on A4. */
export const TEXT_FONT_SIZE: Record<TextSize, number> = { small: 20, medium: 28, large: 40 };
export const TEXT_LINE_HEIGHT = 1.35;

const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Normalize typed text; null if it is empty or too long. */
export function normalizeText(text: string): string | null {
  const value = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return value.trim() && [...value].length <= MAX_TEXT_LENGTH ? value : null;
}

export function validPageText(value: unknown, pageHeight: number): value is PageText {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const box = value as Record<string, unknown>;
  // A thousandth of a unit absorbs floating point rounding at the page edge.
  return typeof box.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(box.id)
    && number(box.x) && number(box.y) && number(box.width)
    && box.x >= 0 && box.y >= 0 && box.y <= pageHeight && box.width >= MIN_TEXT_WIDTH && box.x + box.width <= 1200 + 1e-3
    && typeof box.text === "string" && box.text.trim().length > 0 && [...box.text].length <= MAX_TEXT_LENGTH
    && TEXT_SIZES.includes(box.size as TextSize) && typeof box.color === "string" && /^#[a-fA-F0-9]{6}$/.test(box.color)
    && typeof box.code === "boolean" && Number.isSafeInteger(box.order) && (box.order as number) >= 0;
}
