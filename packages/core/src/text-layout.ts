import { MONO_METRICS, SANS_METRICS } from "./text-metrics.js";
import type { FontMetrics } from "./text-metrics.js";
import { TEXT_FONT_SIZE, TEXT_LINE_HEIGHT } from "./texts.js";
import type { PageText, TextSize } from "./texts.js";

/**
 * Line breaking for text boxes, shared by the desktop editor, the reader view
 * and PDF exports. Widths come from the advance-width table of the bundled
 * fonts (no kerning, no ligatures), so every renderer gets the same lines;
 * renderers draw each returned line as is and never wrap on their own.
 */
export interface TextLayout {
  lines: string[];
  /** Index of each line's first character in the text (UTF-16 code units). */
  starts: number[];
  /** Font size and line height in document units. */
  fontSize: number;
  lineHeight: number;
  height: number;
  /** Distance from a line's top to its baseline, in document units. */
  baseline: number;
}

interface Font { metrics: FontMetrics; widths: Map<number, number>; fallback: number }
const fonts = new Map<FontMetrics, Font>();

function font(metrics: FontMetrics): Font {
  let entry = fonts.get(metrics);
  if (!entry) {
    const widths = new Map<number, number>();
    for (const [first, count, advance] of metrics.runs) for (let index = 0; index < count; index++) widths.set(first + index, advance);
    // Characters outside the fonts are measured like "?"; renderers may show them in a fallback font.
    entry = { metrics, widths, fallback: widths.get(0x3f) ?? metrics.unitsPerEm / 2 };
    fonts.set(metrics, entry);
  }
  return entry;
}

export function textFontMetrics(code: boolean): FontMetrics { return code ? MONO_METRICS : SANS_METRICS; }

/** Whether a character is part of the bundled font (PDF export replaces the others). */
export function textFontHasCharacter(code: boolean, character: string): boolean {
  return font(textFontMetrics(code)).widths.has(character.codePointAt(0)!);
}

/** Width of a string in document units at the given font size. */
export function measureText(text: string, code: boolean, fontSize: number): number {
  const { metrics, widths, fallback } = font(textFontMetrics(code));
  let units = 0;
  for (const character of text) units += widths.get(character.codePointAt(0)!) ?? fallback;
  return units * fontSize / metrics.unitsPerEm;
}

/**
 * Break text into lines no wider than `width`, only at spaces: words are never
 * split, so a single word wider than the box stays on its own line and extends
 * beyond the box. Explicit line breaks are kept. Normal text drops the space
 * at a break; code keeps every space (trailing spaces stay on the line, where
 * they are invisible) and its indentation.
 */
export function layoutText(text: string, size: TextSize, code: boolean, width: number): TextLayout {
  const fontSize = TEXT_FONT_SIZE[size], lineHeight = fontSize * TEXT_LINE_HEIGHT;
  const fits = (line: string): boolean => measureText(line.replace(/ +$/, ""), code, fontSize) <= width + 1e-6;
  const lines: string[] = [], starts: number[] = [];
  let offset = 0;
  for (const paragraph of text.split("\n")) {
    // Lines are substrings of the paragraph; locate each one to know where it starts.
    let cursor = offset;
    const push = (line: string): void => {
      const start = text.indexOf(line, cursor);
      starts.push(start < 0 ? cursor : start);
      cursor = (start < 0 ? cursor : start) + line.length;
      lines.push(line);
    };
    let line = "";
    if (code) {
      // Tokens are runs of spaces or of other characters; a word token that does not fit starts a new line.
      for (const token of paragraph.match(/ +|[^ ]+/g) ?? []) {
        // Indentation stays with the following word, so no line consists of spaces only.
        if (line.trim() && token[0] !== " " && !fits(line + token)) { push(line); line = ""; }
        line += token;
      }
    } else {
      for (const word of paragraph.split(" ")) {
        const candidate = line ? `${line} ${word}` : word;
        if (!line || fits(candidate)) { line = candidate; continue; }
        push(line);
        line = word;
      }
    }
    push(line);
    offset += paragraph.length + 1;
  }
  const { metrics } = font(textFontMetrics(code));
  // CSS half-leading: the glyph box (ascent + descent) is centred in the line box.
  const glyphHeight = (metrics.ascent - metrics.descent) * fontSize / metrics.unitsPerEm;
  const baseline = (lineHeight - glyphHeight) / 2 + metrics.ascent * fontSize / metrics.unitsPerEm;
  return { lines, starts, fontSize, lineHeight, height: lines.length * lineHeight, baseline };
}

export function textBoxLayout(box: Pick<PageText, "text" | "size" | "code" | "width">): TextLayout {
  return layoutText(box.text, box.size, box.code, box.width);
}

/** Topmost text box at a document point. */
export function textAt<T extends PageText>(boxes: readonly T[], point: { x: number; y: number }): T | null {
  let found: T | null = null;
  for (const box of boxes) {
    const height = textBoxLayout(box).height;
    if (point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + height
      && (!found || box.order > found.order)) found = box;
  }
  return found;
}
