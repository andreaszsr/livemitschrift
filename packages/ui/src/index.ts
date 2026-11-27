import {toolbarDrag} from './customizer-drag.js';
import {movePinnedAction} from './toolbar-order.js';
import type {ToolbarDestination} from './toolbar-order.js';

export const icons: Record<string, string> = {
    download: '<path d="M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4"/>',
    backup: '<path d="M4 3h13l4 4v14H3V3Z M7 3v6h10V3 M7 21v-8h10v8"/>',
    restore: '<path d="M4 10a8 8 0 1 1 0 5 M4 4v6h6 M12 8v5l3 2"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2"/>',
    drawer: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    tools: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18 M7 7h2 M12 7h2 M17 7h1"/>',
    pen: '<path d="m4 16-1 5 5-1L20 8l-4-4Z M13 7l4 4"/>',
    eraser: '<path d="m3 15 9-11 9 8-7 9H9Z M7 11l9 8 M14 21h7"/>',
    undo: '<path d="M8 5 3 10l5 5 M3 10h11a6 6 0 0 1 0 12"/>',
    redo: '<path d="m16 5 5 5-5 5 M21 10H10a6 6 0 0 0 0 12"/>',
    pdf: '<path d="M6 3h8l4 4v14H6Z M14 3v5h5 M9 12h6 M9 16h4"/>',
    blank: '<path d="M5 3h14v18H5Z M9 12h6 M12 9v6"/>',
    plus: '<path d="M12 4v16 M4 12h16"/>',
    link: '<path d="m9 8 3-3a5 5 0 0 1 7 7l-3 3 M15 16l-3 3a5 5 0 0 1-7-7l3-3 M8 16l8-8"/>',
    pin: '<path d="M8 3h8l-1 7 4 4H5l4-4Z M12 14v8"/>',
    move: '<path d="M12 2v20 M2 12h20 M8 6l4-4 4 4 M8 18l4 4 4-4 M6 8l-4 4 4 4 M18 8l4 4-4 4"/>',
    grip: '<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    left: '<path d="m15 5-7 7 7 7"/>', right: '<path d="m9 5 7 7-7 7"/>', up: '<path d="m5 15 7-7 7 7"/>', down: '<path d="m5 9 7 7 7-7"/>',
    close: '<path d="m5 5 14 14 M19 5 5 19"/>', check: '<path d="m4 12 5 5L20 6"/>',
    zoom: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6 M6 10h8 M10 6v8"/>',
    follow: '<circle cx="12" cy="12" r="4"/><path d="M7 4a9 9 0 0 0 0 16 M17 4a9 9 0 0 1 0 16"/>',
    settings: '<path d="M3 6h18 M3 12h18 M3 18h18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    diagnostic: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    trash: '<path d="M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6 M12 7.5v.01"/>',
    lasso: '<path d="M7 18c-3-1-4-4-3-7 2-5 9-7 13-5 4 2 4 7 0 9-2 1-5 1-7 0" stroke-dasharray="3 2.5"/><path d="M7 18l-1 3 M7 18c1 1 1 2 0 3"/>',
    marker: '<path d="m9 15-3 3H3v-3l3-3 M6 12l8-8 6 6-8 8Z M3 21h18"/>',
    laser: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4 M12 18v4 M2 12h4 M18 12h4 M5 5l2.5 2.5 M16.5 16.5 19 19 M5 19l2.5-2.5 M16.5 7.5 19 5"/>',
    fullscreen: '<path d="M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5"/>',
    qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3Z M20 14v.01 M14 20h.01 M17 20h4v-3"/>',
    note: '<path d="M4 4h16v11l-5 5H4Z M15 20v-5h5 M8 9h8 M8 13h4"/>',
    notes: '<path d="M8 3h12v14 M4 7h12v14H4Z M7 12h6 M7 16h4"/>',
    'shape-rectangle': '<path d="M4 6h16v12H4Z"/>',
    'shape-circle': '<circle cx="12" cy="12" r="8"/>',
    'shape-quadrant': '<path d="M5 20V4 M5 20h15 M5 4 3 7 M5 4l2 3 M20 20l-3-2 M20 20l-3 2 M9 19v2 M13 19v2 M4 16h2 M4 12h2"/>',
    'shape-cross': '<path d="M12 3v18 M3 12h18 M12 3l-2 3 M12 3l2 3 M21 12l-3-2 M21 12l-3 2"/>',
    snap: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4Z M6 8h4 M14 8h4"/>',
    grid: '<path d="M4 4h16v16H4Z M4 9.3h16 M4 14.7h16 M9.3 4v16 M14.7 4v16"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',
};
export function icon(name: string): string { return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name] ?? icons.more}</svg>`; }
export function button(label: string, name: string, onClick: () => void, description = label): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.title = description;
    node.setAttribute('aria-label', label);
    node.innerHTML = icon(name);
    node.addEventListener('click', onClick);
    return node;
}
export function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
export interface ToolbarAction {
    id: string;
    label: string;
    description?: string;
    icon: string;
    run(): void;
    disabled?: boolean;
    pressed?: boolean;
    color?: string;
    strokeWidth?: number;
}
export interface ToolbarPreferences {
    floating: boolean;
    /** A floating bar dragged to the left/right window edge turns vertical. */
    vertical: boolean;
    x: number;
    y: number;
    pinned: string[];
}
export function toolbarPreferences(value: unknown, defaults: string[], floating: boolean): ToolbarPreferences {
    if (!value || typeof value !== 'object')
        return { floating, vertical: false, x: 0, y: 0, pinned: [...defaults] };
    const input = value as Partial<ToolbarPreferences>;
    return { floating: typeof input.floating === 'boolean' ? input.floating : floating, vertical: input.vertical === true,
        x: typeof input.x === 'number' && Number.isFinite(input.x) ? Math.max(0, input.x) : 0,
        y: typeof input.y === 'number' && Number.isFinite(input.y) ? Math.max(0, input.y) : 0,
        pinned: Array.isArray(input.pinned) ? [...new Set(input.pinned.filter(id => defaults.includes(id)))] : [...defaults] };
}
/** One row, with a user-selected action order and temporary responsive overflow. */
export class Toolbar {
    private actions: ToolbarAction[] = [];
    private core: HTMLElement[] = [];
    private overflow: string[] = [];
    private floatingTopInset = 0;
    private displayedY = 0;
    private menu: HTMLDivElement;
    private customize: HTMLDialogElement;
    private drag: {
        x: number;
        y: number;
        startX: number;
        startY: number;
    } | null = null;
    readonly preferences: ToolbarPreferences;
    constructor(readonly host: HTMLElement, private readonly defaults: string[], floating: boolean, private readonly changed: (preferences: ToolbarPreferences) => void, private readonly customizeActions: ToolbarAction[] = []) {
        this.preferences = toolbarPreferences(null, defaults, floating);
        host.classList.add('toolbar-host');
        this.menu = document.createElement('div');
        this.menu.className = 'toolbar-menu';
        this.menu.hidden = true;
        document.body.append(this.menu);
        this.customize = document.createElement('dialog');
        this.customize.className = 'customizer';
        document.body.append(this.customize);
        new ResizeObserver(() => this.fit()).observe(document.body);
        window.addEventListener('resize', () => { this.menu.hidden = true; this.fit(); });
        document.addEventListener('pointerdown', event => { if (!this.menu.contains(event.target as Node) && !this.host.contains(event.target as Node))
            this.menu.hidden = true; });
        document.addEventListener('keydown', event => { if (event.key === 'Escape')
            this.menu.hidden = true; });
    }
    configure(value: unknown): void { Object.assign(this.preferences, toolbarPreferences(value, this.defaults, this.preferences.floating)); this.render(); }
    update(core: HTMLElement[], actions: ToolbarAction[]): void { this.core = core; this.actions = actions; this.render(); }
    /** Avoid an open top panel without overwriting the user's floating position. */
    setFloatingTopInset(height: number): void { this.floatingTopInset = Math.max(0, height); this.position(); }
    toggleDock(): void { this.preferences.floating = !this.preferences.floating; this.preferences.x = 0; this.preferences.y = 0; this.render(); this.changed({ ...this.preferences, pinned: [...this.preferences.pinned] }); }
    private action(id: string, labelled = false): HTMLButtonElement | null {
        const action = this.actions.find(action => action.id === id);
        if (!action)
            return null;
        const node = button(action.label, action.icon, () => { this.menu.hidden = true; action.run(); }, action.description);
        node.dataset.action = id;
        node.disabled = action.disabled ?? false;
        if (action.pressed !== undefined)
            node.setAttribute('aria-pressed', String(action.pressed));
        if (action.color) {
            node.innerHTML = '<span class="color-dot"></span>';
            node.style.setProperty('--ink-color', action.color);
        }
        if (action.strokeWidth !== undefined) {
            // A straight bar whose thickness follows the stroke width, always in
            // the icon color, so widths never look like the round color swatches.
            const thickness = Math.min(12, 1 + action.strokeWidth * .55), inset = 3 + thickness / 2;
            node.innerHTML = `<svg class="pen-width-bar" viewBox="0 0 24 24" aria-hidden="true"><path d="M${inset} 12H${24 - inset}" fill="none" stroke="currentColor" stroke-width="${thickness.toFixed(2)}" stroke-linecap="round"/></svg>`;
        }
        if (labelled) {
            const text = document.createElement('span');
            text.textContent = action.label;
            node.append(text);
        }
        return node;
    }
    private render(): void {
        this.host.replaceChildren();
        this.host.classList.toggle('floating', this.preferences.floating);
        this.host.classList.toggle('vertical', this.preferences.floating && this.preferences.vertical);
        this.menu.hidden = true;
        if (this.preferences.floating) {
            const grip = button('Leiste verschieben; Pfeiltasten bewegen, Pos1 setzt zurück', 'grip', () => { });
            grip.className = 'toolbar-grip';
            this.host.append(grip);
            grip.addEventListener('pointerdown', event => { if (event.button !== 0)
                return; event.preventDefault(); grip.setPointerCapture(event.pointerId); this.drag = { x: event.clientX, y: event.clientY, startX: this.preferences.x, startY: this.displayedY }; });
            grip.addEventListener('pointermove', event => { if (!this.drag)
                return; this.preferences.x = this.drag.startX + event.clientX - this.drag.x; this.preferences.y = this.drag.startY + event.clientY - this.drag.y; this.orient(event); this.position(); });
            const end = () => { if (this.drag) {
                this.drag = null;
                this.changed({ ...this.preferences, pinned: [...this.preferences.pinned] });
            } };
            grip.addEventListener('pointerup', end);
            grip.addEventListener('pointercancel', end);
            grip.addEventListener('lostpointercapture', end);
            grip.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key))
                return; event.preventDefault(); if (event.key === 'Home') {
                this.preferences.x = 0;
                this.preferences.y = 0;
            }
            else {
                this.preferences.x += event.key === 'ArrowRight' ? 10 : event.key === 'ArrowLeft' ? -10 : 0;
                this.preferences.y = this.displayedY + (event.key === 'ArrowDown' ? 10 : event.key === 'ArrowUp' ? -10 : 0);
            } this.position(); this.changed({ ...this.preferences, pinned: [...this.preferences.pinned] }); });
        }
        this.host.append(...this.core);
        const strip = document.createElement('div');
        strip.className = 'toolbar-actions';
        for (const id of this.preferences.pinned) {
            const action = this.action(id);
            if (action)
                strip.append(action);
        }
        this.host.append(strip);
        const more = button('Weitere Aktionen und Leiste anpassen', 'more', () => this.openMenu(), 'Ausgeblendete Werkzeuge öffnen oder die Anordnung der Leiste ändern.');
        more.className = 'toolbar-more';
        this.host.append(more);
        this.fit();
        requestAnimationFrame(() => this.fit());
    }
    /**
     * Near a side edge the bar turns vertical, near the top/bottom edge
     * horizontal; in a corner the closer edge wins. After a switch the grip is
     * re-anchored under the pointer so dragging continues smoothly.
     */
    private orient(event: PointerEvent): void {
        const edge = 56, distances = {left: event.clientX, right: window.innerWidth - event.clientX, top: event.clientY, bottom: window.innerHeight - event.clientY};
        const side = Math.min(distances.left, distances.right), end = Math.min(distances.top, distances.bottom);
        const vertical = side <= edge && side < end ? true : end <= edge && end <= side ? false : this.preferences.vertical;
        if (vertical === this.preferences.vertical || !this.drag) return;
        this.preferences.vertical = vertical;
        this.host.classList.toggle('vertical', vertical);
        this.preferences.x = event.clientX - 28; this.preferences.y = event.clientY - 28;
        this.drag = { x: event.clientX, y: event.clientY, startX: this.preferences.x, startY: this.preferences.y };
        this.fit();
    }
    private position(): void {
        if (!this.preferences.floating) {
            this.host.style.transform = '';
            return;
        }
        this.preferences.x = Math.max(0, Math.min(this.preferences.x, window.innerWidth - this.host.offsetWidth - 20));
        this.preferences.y = Math.max(0, Math.min(this.preferences.y, window.innerHeight - this.host.offsetHeight - 20));
        // Only a horizontal bar must make room below the top panel; a vertical one sits beside it.
        const inset = this.preferences.floating && this.preferences.vertical ? 0 : this.floatingTopInset;
        this.displayedY = Math.min(Math.max(0, window.innerHeight - this.host.offsetHeight - 20), Math.max(this.preferences.y, inset));
        this.host.style.transform = `translate(${this.preferences.x}px,${this.displayedY}px)`;
        this.host.dataset.edge = this.preferences.x + this.host.offsetWidth / 2 < window.innerWidth / 2 ? 'left' : 'right';
    }
    /** CSS may turn the bar into a vertical rail (landscape phones); overflow then runs along the height. */
    private get vertical(): boolean { return getComputedStyle(this.host).flexDirection === 'column'; }
    private fit(): void {
        const actions = [...this.host.querySelectorAll<HTMLButtonElement>('.toolbar-actions>button')];
        actions.forEach(action => { action.hidden = false; });
        const vertical = this.vertical;
        for (const action of [...actions].reverse()) {
            if (vertical ? this.host.scrollHeight <= this.host.clientHeight + 1 : this.host.scrollWidth <= this.host.clientWidth + 1)
                break;
            action.hidden = true;
        }
        this.overflow = actions.filter(action => action.hidden).map(action => action.dataset.action!);
        this.position();
    }
    private openMenu(): void {
        if (!this.menu.hidden) {
            this.menu.hidden = true;
            return;
        }
        this.menu.replaceChildren();
        for (const action of this.actions) {
            if (!this.preferences.pinned.includes(action.id) || this.overflow.includes(action.id)) {
                const node = this.action(action.id, true);
                if (node)
                    this.menu.append(node);
            }
        }
        const configure = button('Leiste anpassen', 'settings', () => { this.menu.hidden = true; this.openCustomizer(); });
        configure.append(document.createTextNode('Leiste anpassen'));
        this.menu.append(configure);
        const rect = this.host.getBoundingClientRect();
        this.menu.hidden = false;
        // Below a horizontal bar; beside a vertical rail.
        const left = this.vertical ? rect.right + 6 : rect.right - this.menu.offsetWidth, top = this.vertical ? 8 : rect.bottom + 6;
        this.menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - this.menu.offsetWidth - 8))}px`;
        this.menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - this.menu.offsetHeight - 8))}px`;
        this.menu.querySelector<HTMLButtonElement>('button')?.focus();
    }
    openCustomizer(): void {
        this.customize.replaceChildren();
        const header = document.createElement('header');
        const heading = document.createElement('h2');
        heading.textContent = 'Leiste anpassen';
        header.append(heading, button('Schließen', 'close', () => this.customize.close()));
        this.customize.append(header);
        const hint = document.createElement('p');
        hint.textContent = 'Aktionen ziehen oder mit den Pfeilen verschieben. Bei wenig Platz landen angeheftete Aktionen vorübergehend im Menü.';
        this.customize.append(hint);
        for (const action of this.customizeActions) {
            const node = button(action.label, action.icon, () => {this.customize.close(); action.run();});
            node.dataset.action = action.id;
            node.append(document.createTextNode(action.label));
            this.customize.append(node);
        }
        const columns = document.createElement('div');
        columns.className = 'customizer-columns';
        for (const target of ['toolbar', 'menu'] as const) {
            const column = document.createElement('section');
            const title = document.createElement('h3');
            title.textContent = target === 'toolbar' ? 'In der Leiste' : 'Im „…“-Menü';
            column.append(title);
            const zone = document.createElement('div');
            zone.className = 'customizer-zone';
            zone.dataset.target = target;
            const ids = target === 'toolbar' ? this.preferences.pinned : this.actions.filter(action => !this.preferences.pinned.includes(action.id)).map(action => action.id);
            for (const [index, id] of ids.entries()) {
                const action = this.actions.find(action => action.id === id);
                if (!action)
                    continue;
                const row = document.createElement('div');
                row.className = 'customizer-row';
                row.dataset.id = id;
                const label = document.createElement('span');
                label.textContent = action.label;
                const handle = button(`${action.label} ziehen`, 'grip', () => {}, 'Am Griff ziehen, um die Reihenfolge zu ändern oder das Werkzeug zwischen Leiste und Menü zu verschieben.');
                handle.className = 'customizer-grip';
                row.append(handle, label);
                const move = (destination: ToolbarDestination, before?: string) => {
                    this.preferences.pinned = movePinnedAction(this.preferences.pinned, id, destination, before);
                    this.changed({ ...this.preferences, pinned: [...this.preferences.pinned] }); this.render(); this.openCustomizer();
                };
                toolbarDrag(this.customize, handle, move);
                if (target === 'toolbar')
                    for (const delta of [-1, 1]) {
                        const node = button(`${action.label} ${delta < 0 ? 'nach vorne' : 'nach hinten'}`, delta < 0 ? 'up' : 'down', () => { const next = [...this.preferences.pinned]; [next[index], next[index + delta]] = [next[index + delta]!, next[index]!]; this.preferences.pinned = next; this.changed({ ...this.preferences, pinned: [...next] }); this.render(); this.openCustomizer(); });
                        node.disabled = index + delta < 0 || index + delta >= ids.length;
                        row.append(node);
                    }
                row.append(button(`${action.label} ${target === 'toolbar' ? 'ins Menü' : 'in die Leiste'}`, target === 'toolbar' ? 'right' : 'left', () => move(target === 'toolbar' ? 'menu' : 'toolbar')));
                zone.append(row);
            }
            column.append(zone);
            columns.append(column);
        }
        this.customize.append(columns);
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = 'Standardanordnung';
        reset.title = 'Reihenfolge und sichtbare Werkzeuge auf die Standardanordnung zurücksetzen. Eigene Farben und Dicken bleiben erhalten.';
        reset.addEventListener('click', () => { this.preferences.pinned = [...this.defaults]; this.changed({ ...this.preferences, pinned: [...this.defaults] }); this.render(); this.openCustomizer(); });
        this.customize.append(reset);
        if (!this.customize.open)
            this.customize.showModal();
    }
}

export { ViewportZoom, zoomPreferences, zoomAnchor, zoomScrollDelta, addZoomLockAction, zoomControls } from './zoom.js';
export type { ZoomPreferences } from './zoom.js';
export { linkParts, linkedText } from './links.js';
export type { TextPart } from './links.js';
