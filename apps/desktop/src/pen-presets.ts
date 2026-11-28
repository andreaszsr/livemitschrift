export interface PenPreferences {
    colors: string[];
    widths: number[];
    color: string;
    width: number;
    /** Highlighter palette; drawn translucently, so bright colors work best. */
    markerColors: string[];
    markerColor: string;
    markerWidths: number[];
    markerWidth: number;
}

const DEFAULT_COLORS = ['#243147', '#356eaa', '#b44049', '#397566'];
/** Yellow, green, blue, pink, orange. */
export const DEFAULT_MARKER_COLORS = ['#ffd400', '#7ed957', '#5ce1e6', '#ff66c4', '#ffa14a'];
/** Marker widths stay within the stroke width limit (0.5–20) enforced by storage and server. */
export const DEFAULT_MARKER_WIDTHS = [8, 14, 20];
const DEFAULT_WIDTHS = [1.5, 3.5, 7];

/** Preferences are optional local data; reject malformed values before use. */
export function penPreferences(value: unknown): PenPreferences {
    const input = value && typeof value === 'object' ? value as Partial<PenPreferences> : {};
    const palette = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value
        .filter((color): color is string => typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color))
        .map(color => color.toLowerCase()))] : [];
    const colors = palette(input.colors), markerColors = palette(input.markerColors);
    const sizes = (value: unknown): number[] => Array.isArray(value) ? [...new Set(value
        .filter((width): width is number => typeof width === 'number' && Number.isFinite(width) && width >= .5 && width <= 20))] : [];
    const widths = sizes(input.widths), markerWidths = sizes(input.markerWidths);
    if (!markerWidths.length) markerWidths.push(...DEFAULT_MARKER_WIDTHS);
    const markerWidth = input.markerWidth ?? 14;
    if (!colors.length) colors.push(...DEFAULT_COLORS);
    if (!widths.length) widths.push(...DEFAULT_WIDTHS);
    if (!markerColors.length) markerColors.push(...DEFAULT_MARKER_COLORS);
    const markerColor = typeof input.markerColor === 'string' ? input.markerColor.toLowerCase() : markerColors[0]!;
    const color = typeof input.color === 'string' ? input.color.toLowerCase() : DEFAULT_COLORS[0]!;
    const width = input.width ?? 3.5;
    return {colors, widths, color: colors.includes(color) ? color : colors[0]!, width: widths.includes(width) ? width : widths[0]!,
        markerColors, markerColor: markerColors.includes(markerColor) ? markerColor : markerColors[0]!,
        markerWidths, markerWidth: markerWidths.includes(markerWidth) ? markerWidth : markerWidths[Math.floor(markerWidths.length / 2)]!};
}

export function writingActionIds(pen: PenPreferences): string[] {
    // Lecture essentials first: marker, laser pointer, "blank page after" and the grid.
    // Color slots are shared: pen colors normally, marker colors while marking.
    const slots = Math.max(pen.colors.length, pen.markerColors.length), sizes = Math.max(pen.widths.length, pen.markerWidths.length);
    return ['undo', 'redo', 'pen', 'eraser', 'highlighter', 'lasso', 'laser', 'blank-page', 'grid', 'text', 'shape', 'snap', ...Array.from({length: sizes}, (_, index) => `width-${index}`),
        ...Array.from({length: slots}, (_, index) => `color-${index}`)];
}

/** Retain deliberate ordering/hiding; newly added favorites start visible. */
export function updatedWritingPins(pinned: string[], previous: string[], next: string[]): string[] {
    return [...pinned.filter(id => next.includes(id)), ...next.filter(id => !previous.includes(id))];
}
