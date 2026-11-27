import { GRID_SPACINGS, GRID_STYLES } from './page-grid.js';
import type { Grid, GridSpacing, GridStyle } from './page-grid.js';

const STYLE_LABELS: Record<GridStyle | 'none', string> = {none: 'Aus', squares: 'Karo', lines: 'Linien', dots: 'Punkte'};

/**
 * Style and spacing selects for one scope. With `inherit`, an extra first
 * option means "no own setting" and reports null.
 */
export function gridFields(label: string, value: Grid | null, inherit: {label: string; grid: Grid} | null, changed: (grid: Grid | null) => void): HTMLFieldSetElement {
    const fieldset = document.createElement('fieldset'), legend = document.createElement('legend');
    fieldset.className = 'grid-fields';
    legend.textContent = label;
    const style = document.createElement('select'), spacing = document.createElement('select');
    style.title = `Raster für ${label}: Karo, Linien, Punkte oder aus.`;
    spacing.title = `Rasterabstand für ${label} in Millimetern (bezogen auf eine A4-breite Seite).`;
    if (inherit) style.append(new Option(`${inherit.label} (${describeGrid(inherit.grid)})`, 'inherit'));
    for (const id of ['none', ...GRID_STYLES] as const) style.append(new Option(STYLE_LABELS[id], id));
    for (const mm of GRID_SPACINGS) spacing.append(new Option(`${mm} mm`, String(mm)));
    const shown = value ?? inherit?.grid ?? {style: 'none', spacing: 5};
    style.value = value ? value.style : inherit ? 'inherit' : shown.style;
    spacing.value = String(shown.spacing);
    const sync = (): void => { spacing.disabled = style.value === 'inherit' || style.value === 'none'; };
    const report = (): void => {
        sync();
        changed(style.value === 'inherit' ? null : {style: style.value as Grid['style'], spacing: Number(spacing.value) as GridSpacing});
    };
    style.addEventListener('change', report);
    spacing.addEventListener('change', report);
    sync();
    fieldset.append(legend, style, spacing);
    return fieldset;
}

export function describeGrid(grid: Grid): string {
    return grid.style === 'none' ? 'aus' : `${STYLE_LABELS[grid.style]}, ${grid.spacing} mm`;
}
