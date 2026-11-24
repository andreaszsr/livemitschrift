import {button} from '@livemitschrift/ui';
import {penPreferences} from './pen-presets.js';
import type {PenPreferences} from './pen-presets.js';

/** Edit a draft; closing the dialog without applying never changes drawing. */
export function penPresetsForm(dialog: HTMLDialogElement, current: PenPreferences,
    save: (next: PenPreferences) => void): void {
    let colors = [...current.colors], widths = [...current.widths], markerColors = [...current.markerColors], markerWidths = [...current.markerWidths];
    const form = document.createElement('form');
    form.className = 'pen-presets-form';
    const hint = document.createElement('p');
    hint.textContent = 'Eigene Favoriten hinzufügen oder vorhandene ändern. Farben per Farbfeld oder Hex-Wert, Dicken von 0,5 bis 20. Mit „Übernehmen“ speichern.';
    dialog.append(hint, form);
    const render = (): void => {
        form.replaceChildren();
        const columns = document.createElement('div'); columns.className = 'pen-presets-columns';
        const group = (title: string): HTMLFieldSetElement => {
            const field = document.createElement('fieldset'), legend = document.createElement('legend');
            legend.textContent = title; field.append(legend); columns.append(field); return field;
        };
        const paletteEditor = (title: string, kind: string, get: () => string[]): void => {
            const colors = get();
            const palette = group(title);
            colors.forEach((value, index) => {
                const row = document.createElement('div'); row.className = 'pen-preset-row';
                const label = document.createElement('label'); label.textContent = `Farbe ${index + 1}`;
                const input = document.createElement('input'); input.type = 'color'; input.value = value;
                input.title = 'Farbauswahl öffnen und diesen Farbfavoriten ändern.';
                input.dataset.penColor = `${kind}-${index}`;
                const hex = document.createElement('input'); hex.type = 'text'; hex.value = value;
                hex.required = true; hex.pattern = '#[a-fA-F0-9]{6}'; hex.maxLength = 7;
                hex.setAttribute('aria-label', `Farbwert ${index + 1}`); hex.dataset.penColorHex = `${kind}-${index}`;
                hex.title = 'Farbe als Hex-Wert mit sechs Stellen eingeben, zum Beispiel #397566.';
                hex.addEventListener('input', () => {colors[index] = hex.value.toLowerCase(); if (hex.checkValidity()) input.value = hex.value;});
                input.addEventListener('input', () => {colors[index] = input.value; hex.value = input.value;}); label.append(input, hex);
                const remove = button(`Farbe ${index + 1} entfernen`, 'close', () => {colors.splice(index, 1); render();});
                remove.title = 'Diesen Farbfavoriten entfernen. Vorhandene Handschrift bleibt unverändert.';
                remove.disabled = colors.length === 1; row.append(label, remove); palette.append(row);
            });
            const addColor = button('Farbe hinzufügen', 'plus', () => {
                let value = 0;
                const hex = (): string => `#${value.toString(16).padStart(6, '0')}`;
                while (colors.includes(hex())) value++;
                colors.push(hex());
                render();
                const input = form.querySelector<HTMLInputElement>(`[data-pen-color-hex="${kind}-${colors.length - 1}"]`);
                input?.focus(); input?.select();
            });
            addColor.append(document.createTextNode('Farbe hinzufügen')); palette.append(addColor);
            addColor.title = 'Einen weiteren Farbfavoriten anlegen, den Farbwert wählen und anschließend „Übernehmen“ drücken.';
        };
        paletteEditor('Farben', 'pen', () => colors);
        paletteEditor('Markerfarben', 'marker', () => markerColors);
        const widthEditor = (title: string, kind: string, get: () => number[]): void => {
            const widths = get();
            const sizes = group(title);
            widths.forEach((value, index) => {
                const row = document.createElement('div'); row.className = 'pen-preset-row';
                const label = document.createElement('label'); label.textContent = `Dicke ${index + 1}`;
                const input = document.createElement('input'); input.type = 'number'; input.min = '.5'; input.max = '20'; input.step = 'any';
                input.title = 'Eigene Strichdicke zwischen 0,5 und 20 eingeben. Dezimalwerte sind erlaubt.';
                input.required = true; input.value = Number.isFinite(value) ? String(value) : ''; input.dataset.penWidth = `${kind}-${index}`;
                input.addEventListener('input', () => {widths[index] = input.valueAsNumber;}); label.append(input);
                const remove = button(`Strichdicke ${index + 1} entfernen`, 'close', () => {widths.splice(index, 1); render();});
                remove.title = 'Diesen Dickenfavoriten entfernen. Vorhandene Handschrift bleibt unverändert.';
                remove.disabled = widths.length === 1; row.append(label, remove); sizes.append(row);
            });
            const addWidth = button('Strichdicke hinzufügen', 'plus', () => {
                widths.push(NaN); render();
                form.querySelector<HTMLInputElement>(`[data-pen-width="${kind}-${widths.length - 1}"]`)?.focus();
            });
            addWidth.append(document.createTextNode('Dicke hinzufügen')); sizes.append(addWidth);
            addWidth.title = 'Einen weiteren Dickenfavoriten anlegen, den gewünschten Wert eingeben und anschließend „Übernehmen“ drücken.';
        };
        widthEditor('Strichdicken', 'pen', () => widths);
        widthEditor('Markerdicken', 'marker', () => markerWidths);
        const error = document.createElement('p'); error.id = 'pen-presets-error'; error.setAttribute('role', 'alert'); error.hidden = true;
        const actions = document.createElement('div'); actions.className = 'dialog-actions';
        const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Standardwerte';
        reset.title = 'Die vorgeschlagenen Farben und Dicken wiederherstellen. Erst „Übernehmen“ speichert diese Änderung.';
        reset.addEventListener('click', () => {const defaults = penPreferences(null); colors = defaults.colors; widths = defaults.widths; markerColors = defaults.markerColors; markerWidths = defaults.markerWidths; render();});
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Abbrechen'; cancel.addEventListener('click', () => dialog.close());
        cancel.title = 'Dialog schließen und die hier noch nicht übernommenen Änderungen verwerfen.';
        const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'primary'; submit.textContent = 'Übernehmen';
        submit.title = 'Farben und Dicken speichern und in der Schreibleiste verfügbar machen.';
        actions.append(reset, cancel, submit); form.append(columns, error, actions);
    };
    form.addEventListener('submit', event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        if (new Set(colors).size !== colors.length || new Set(widths).size !== widths.length || new Set(markerColors).size !== markerColors.length || new Set(markerWidths).size !== markerWidths.length) {
            const error = form.querySelector<HTMLElement>('#pen-presets-error')!;
            error.textContent = 'Bitte unterschiedliche Farben und Strichdicken wählen.'; error.hidden = false; return;
        }
        save(penPreferences({...current, colors, widths, markerColors, markerWidths})); dialog.close();
    });
    render();
}
