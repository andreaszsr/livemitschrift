/**
 * Lecturer-only grid behind each page. Grid settings are local preferences:
 * they are never synchronized, published or exported. The effective grid of
 * a page is its own setting, else its topic's, else the notebook default.
 */

export const GRID_STYLES = ['squares', 'lines', 'dots'] as const;
export type GridStyle = typeof GRID_STYLES[number];
/** Spacing in millimetres on a page of A4 width. */
export const GRID_SPACINGS = [4, 5, 8, 10] as const;
export type GridSpacing = typeof GRID_SPACINGS[number];

export interface Grid { style: GridStyle | 'none'; spacing: GridSpacing }
export interface NotebookGrid {
    default: Grid;
    topics: Record<string, Grid>;
    pages: Record<string, Grid>;
}

export const NO_GRID: Grid = {style: 'none', spacing: 5};
/** Notebook page width in document units; it corresponds to 210 mm (A4 width). */
const PAGE_WIDTH = 1200, PAGE_WIDTH_MM = 210;

export const gridPreferenceKey = (notebookId: string): string => `grid:${notebookId}`;
/** The grid chosen last, proposed for the next new notebook. */
export const LAST_GRID_KEY = 'grid-last';

export function validGrid(value: unknown): value is Grid {
    if (!value || typeof value !== 'object') return false;
    const grid = value as Record<string, unknown>;
    return (grid.style === 'none' || GRID_STYLES.includes(grid.style as GridStyle)) && GRID_SPACINGS.includes(grid.spacing as GridSpacing);
}

export function parseGrid(text: string | undefined): Grid {
    try {
        const value: unknown = text ? JSON.parse(text) : null;
        return validGrid(value) ? {style: value.style, spacing: value.spacing} : NO_GRID;
    } catch { return NO_GRID; }
}

/** Stored notebook grid; invalid parts fall back to "no grid" or are dropped. */
export function parseNotebookGrid(text: string | undefined): NotebookGrid {
    const result: NotebookGrid = {default: NO_GRID, topics: {}, pages: {}};
    let value: unknown;
    try { value = text ? JSON.parse(text) : null; } catch { return result; }
    if (!value || typeof value !== 'object') return result;
    const stored = value as Record<string, unknown>;
    if (validGrid(stored.default)) result.default = {style: stored.default.style, spacing: stored.default.spacing};
    for (const scope of ['topics', 'pages'] as const) {
        const entries = stored[scope];
        if (!entries || typeof entries !== 'object') continue;
        for (const [id, grid] of Object.entries(entries)) if (validGrid(grid)) result[scope][id] = {style: grid.style, spacing: grid.spacing};
    }
    return result;
}

/** Serialize, dropping overrides of topics and pages that no longer exist. */
export function serializeNotebookGrid(grid: NotebookGrid, topicIds: Iterable<string>, pageIds: Iterable<string>): string {
    const keep = (entries: Record<string, Grid>, ids: Iterable<string>): Record<string, Grid> => {
        const known = new Set(ids);
        return Object.fromEntries(Object.entries(entries).filter(([id]) => known.has(id)));
    };
    return JSON.stringify({default: grid.default, topics: keep(grid.topics, topicIds), pages: keep(grid.pages, pageIds)});
}

export function effectiveGrid(grid: NotebookGrid, topicId: string, pageId: string): Grid {
    return grid.pages[pageId] ?? grid.topics[topicId] ?? grid.default;
}

/** Grid spacing in document units. */
export function gridSpacingUnits(spacing: GridSpacing): number {
    return spacing * PAGE_WIDTH / PAGE_WIDTH_MM;
}

/**
 * CSS for the grid layer. Sizes use container query units of the paper
 * (100cqw = paper width = 1200 document units), so the grid scales with the
 * zoom without JavaScript. Lines and dots sit on multiples of the spacing,
 * measured from the page's top left corner.
 */
export function gridBackground(grid: Grid): {image: string; size: string; position: string} | null {
    if (grid.style === 'none') return null;
    const cell = `calc(100cqw * ${gridSpacingUnits(grid.spacing) / PAGE_WIDTH})`;
    const line = '#dbe2ec', dot = '#aeb9c9';
    switch (grid.style) {
        case 'squares': return {
            image: `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
            size: `${cell} ${cell}`, position: '0 0'};
        case 'lines': return {image: `linear-gradient(to bottom, ${line} 1px, transparent 1px)`, size: `100% ${cell}`, position: '0 0'};
        case 'dots': return {
            // Each tile's dot is centred, so shift by half a tile onto the grid points.
            image: `radial-gradient(circle, ${dot} 1.3px, transparent 1.6px)`,
            size: `${cell} ${cell}`, position: `calc(${cell} / -2) calc(${cell} / -2)`};
    }
}
