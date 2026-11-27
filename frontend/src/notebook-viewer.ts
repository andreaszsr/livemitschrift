import { validSyncPage, applyNotebookEvent, findPage, InkDocument, LaserPointer, notebookPages, notebookPdfPlacement, PAGE_SIZE, ViewportInkRenderer } from '@livemitschrift/core';
import type { Notebook, NotebookEvent, NotebookSnapshot, NotePage, Topic, ViewPosition } from '@livemitschrift/core';
import type { ExportNotes } from '@livemitschrift/pdf/export';
import { NotebookPdfRenderer, PageThumbnails } from '@livemitschrift/pdf';
import { addZoomLockAction, button, escapeHtml, icon, Toolbar, ViewportZoom, zoomControls } from '@livemitschrift/ui';
import { PagedConnection } from './paged-connection.js';
import type { ViewerState } from './viewer-state.js';
import { followScrollTop } from './follow-position.js';
import {exportFilename, loadExportTopic} from './topic-export.js';
import { mergeNotes, NoteStore, pageNotes, parseNotes, serializeNotes } from './student-notes.js';
import type { StudentNote } from './student-notes.js';
import type { NoteStorage } from './student-notes.js';
import { NotesLayer } from './notes-layer.js';
function element<T extends HTMLElement>(id: string): T { const node = document.getElementById(id); if (!node)
    throw new Error(`Missing element: ${id}`); return node as T; }
const identity = location.pathname.split('/').at(-1) ?? '', storageKey = `livemitschrift-viewer-${identity}`;
let saved: Record<string, unknown> = {};
try {
    saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, unknown>;
}
catch { /* Storage may be disabled; the viewer still works. */ }
let notebook: Notebook | null = null, current: NotePage | null = null, position: ViewPosition | null = null, follow = saved.follow !== false, state: ViewerState = 'connecting', ignoreScrollUntil = 0;
const positions: Record<string, number> = {};
let notesHintShown = saved.notesHintShown === true;
if (saved.positions && typeof saved.positions === 'object')
    for (const [id, y] of Object.entries(saved.positions))
        if (typeof y === 'number' && Number.isFinite(y) && y >= 0)
            positions[id] = y;
const pageSize = { ...PAGE_SIZE }, ink = new InkDocument(), paper = element('paper'), viewport = element('viewport');
// Element fullscreen exists on Android/desktop browsers; iPhone Safari does not offer it for pages.
// Operator-configured privacy notice (server fills this meta tag; empty when unset).
const privacyUrl = (() => { const value = document.querySelector<HTMLMetaElement>('meta[name=livemitschrift-privacy]')?.content ?? '';
    // Either the server's own /datenschutz page or an external HTTPS page.
    try { const url = new URL(value, location.href); return value && (url.origin === location.origin || url.protocol === 'https:') ? url.href : null; } catch { return null; } })();
// Source of the running server version (AGPL-3.0 section 13); always an HTTPS URL.
const sourceUrl = (() => { const value = document.querySelector<HTMLMetaElement>('meta[name=livemitschrift-source]')?.content ?? '';
    try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } })();
const fullscreenAvailable = document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
const toolbar = new Toolbar(element('toolbar'), [...(fullscreenAvailable ? ['fullscreen'] : []), 'note', 'notes', 'export', 'zoom', 'zoom-lock', 'placement'], false, () => { persist(); update(); });
let exportController: AbortController | null = null, exportUrl: string | null = null;
// Export is offered on existing layouts too, preserving the user's action order.
if (saved.exportActionAdded !== true && saved.toolbar && typeof saved.toolbar === 'object') {
    const layout = saved.toolbar as {pinned?: unknown};
    if (Array.isArray(layout.pinned) && !layout.pinned.includes('export')) layout.pinned.unshift('export');
}
// Notes: "Notiz setzen" first, the overview right after it.
if (saved.notesActionsAdded !== true && saved.toolbar && typeof saved.toolbar === 'object') {
    const layout = saved.toolbar as {pinned?: unknown};
    if (Array.isArray(layout.pinned)) {
        if (!layout.pinned.includes('note')) layout.pinned.unshift('note');
        if (!layout.pinned.includes('notes')) layout.pinned.splice(layout.pinned.indexOf('note') + 1, 0, 'notes');
    }
}
if (saved.fullscreenActionAdded !== true && fullscreenAvailable && saved.toolbar && typeof saved.toolbar === 'object') {
    const layout = saved.toolbar as {pinned?: unknown};
    if (Array.isArray(layout.pinned) && !layout.pinned.includes('fullscreen')) layout.pinned.unshift('fullscreen');
}
const renderer = new ViewportInkRenderer(element<HTMLCanvasElement>('page'), paper, viewport, ink, pageSize, y => { if (current) {
    positions[current.id] = y;
    if (!follow)
        persist();
} });
async function readPdf(asset: string, page = 1): Promise<Uint8Array> { const response = await fetch(`/api/notebook/${identity}/pdf/${asset}/page/${page}`); if (!response.ok)
    throw new Error(`PDF nicht verfügbar (${response.status}).`); return new Uint8Array(await response.arrayBuffer()); }
// Private notes stay in this browser; see student-notes.ts. Accessing
// localStorage itself can throw when site data is blocked.
const noteStorage = ((): NoteStorage | null => { try { return localStorage; } catch { return null; } })();
const notes = new NoteStore(noteStorage, `livemitschrift-notes-${identity}`);
const notesLayer = new NotesLayer(paper, notes, {
    toPoint: (x, y) => renderer.toPoint(x, y, 0),
    dialog: title => dialog(title),
    changed: () => {
        if (!notesHintShown && notes.all.length) {
            notesHintShown = true; persist();
            void navigator.storage?.persist?.().catch(() => false);
            notice('Deine Notizen liegen nur in diesem Browser auf diesem Gerät, nicht auf dem Server. Sichern: Menü → „Meine Notizen“ → „Notizen speichern“.');
        }
        update();
    },
    error: notice,
});
const pdf = new NotebookPdfRenderer(element<HTMLCanvasElement>('pdf-background'), readPdf, error => notice(`PDF konnte nicht dargestellt werden: ${String(error)}`), true);
const laser = new LaserPointer(paper, pageSize);
const zoom = new ViewportZoom(paper, viewport, pageSize, {
    enabled: () => current !== null,
    slideHeight: () => current?.background ? notebookPdfPlacement(current.background).height : null,
    beforeChange: () => {ignoreScrollUntil = Date.now() + 150;},
    gesture: pauseFollow,
    changed: () => {if (follow) followPosition(); renderer.redraw(); update(); persist();},
});
// Phones start once with the whole slide visible; later zoom choices are kept.
const phone = matchMedia('(pointer: coarse) and (max-width: 950px)').matches;
zoom.configure(phone && saved.phoneZoomDefault !== true ? {value: 'page', locked: false} : saved.zoom);
toolbar.configure(addZoomLockAction(saved.toolbar, saved.zoom));
function persist(): void { try {
    localStorage.setItem(storageKey, JSON.stringify({ toolbar: toolbar.preferences, exportActionAdded: true, fullscreenActionAdded: true, notesActionsAdded: true, notesHintShown, phoneZoomDefault: true, follow, pageId: current?.id ?? saved.pageId, positions, zoom: zoom.preferences }));
}
catch { /* Optional per-browser preferences do not gate live viewing. */ } }
function notice(message: string): void { element('notice-text').textContent = message; element('notice').hidden = false; }
function sizePaper(): void {zoom.resize();}
function display(page: NotePage, y = positions[page.id] ?? 0, subscribe = true): void {
    if (subscribe) connection.select(page.id);
    if (current?.id !== page.id) laser.clear();
    current = page;
    Object.assign(pageSize, { width: page.width, height: page.height });
    ink.replace({ type: 'snapshot', page: pageSize, strokes: page.strokes });
    sizePaper();
    ignoreScrollUntil = Date.now() + 150;
    viewport.scrollTop = y * paper.getBoundingClientRect().width / page.width;
    renderer.invalidate();
    void pdf.set(page.background).then(() => { element('pdf-status').textContent = page.background ? `${page.background.name} · Folie ${page.background.pageNumber}` : 'Kein PDF-Hintergrund'; }).catch(error => notice(String(error)));
    notesLayer.render(page);
    update();
    if (!element('drawer').hidden)
        drawer();
}
function followPosition(): void {
    if (!notebook || !position)
        return;
    const page = findPage(notebook, position.pageId);
    if (current?.id !== page.id)
        display(page, position.y);
    const target = followScrollTop(position, page.width, paper.getBoundingClientRect(), viewport.getBoundingClientRect().top, viewport.scrollTop);
    const top = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, target));
    // Stationary viewport updates (including older publishers' focusY) must not
    // reposition or repaint the page for every pen movement.
    if (Math.abs(viewport.scrollTop - top) > .5) {
        ignoreScrollUntil = Date.now() + 150;
        viewport.scrollTop = top;
        renderer.redraw();
    }
}
function pauseFollow(): void { if (!follow)
    return; follow = false; update(); persist(); }
function choosePage(page: NotePage): void { pauseFollow(); display(page); persist(); element('drawer').hidden = true; }
/** Short visible badge text; the longer label explains the state on hover and to screen readers. */
const badges: Record<ViewerState, string> = { connecting: 'Verbinde …', live: 'Live', waiting: 'Dozent offline', disconnected: 'Keine Verbindung', error: 'Nicht verfügbar' };
function update(): void {
    const labels = { connecting: 'Verbinde …', live: 'Live verbunden: neue Notizen erscheinen sofort.', waiting: 'Verbunden, aber die Dozenten-App überträgt gerade nicht. Gespeicherte Notizen bleiben lesbar.', disconnected: 'Keine Verbindung zum Server. Es wird automatisch neu verbunden.', error: 'Liveansicht nicht verfügbar. Bitte den Link prüfen und die Seite neu laden.' };
    element('connection').textContent = labels[state];
    element('connection').dataset.state = state;
    element('follow-return').hidden = follow;
    element('stroke-count').textContent = `${ink.strokes.size} ${ink.strokes.size === 1 ? 'Strich' : 'Striche'}`;
    const navigation = button('Themen dieses Notizbuchs', 'drawer', () => { drawer(); element('drawer').hidden = !element('drawer').hidden; });
    navigation.title = 'Themenübersicht öffnen oder schließen und ein anderes Thema auswählen.';
    navigation.disabled = !notebook;
    const brand = document.createElement('span');
    brand.className = 'brand';
    brand.innerHTML = 'Live<span>Mitschrift</span>';
    const topic = notebook?.topics.find(topic => topic.pages.some(page => page.id === current?.id)), context = document.createElement('span');
    context.className = 'toolbar-context';
    context.textContent = topic?.title ?? notebook?.title ?? 'Liveansicht';
    context.title = `${notebook?.title ?? 'LiveMitschrift'} · Nur lesen`;
    const pages = topic?.pages ?? [], index = pages.findIndex(page => page.id === current?.id), pager = document.createElement('div');
    pager.className = 'page-navigation';
    const previous = button('Vorherige Seite', 'left', () => choosePage(pages[index - 1]!));
    previous.disabled = index <= 0;
    const count = document.createElement('button');
    count.type = 'button';
    count.className = 'page-count';
    count.textContent = pages.length ? `${index + 1} / ${pages.length}` : '—';
    count.title = 'Seitenübersicht öffnen: Vorschau auswählen oder eine Seitennummer eingeben.';
    count.setAttribute('aria-label', 'Seitenzahl und Miniaturen');
    count.disabled = !current;
    count.addEventListener('click', () => pagePicker(pages, index));
    const next = button('Nächste Seite', 'right', () => choosePage(pages[index + 1]!));
    next.disabled = index < 0 || index >= pages.length - 1;
    pager.append(previous, count, next);
    const followButton = button(follow ? 'Follow aktiv: Seite und Scrollposition' : 'Follow einschalten', 'follow', () => { follow = !follow; if (follow)
        followPosition(); update(); persist(); });
    followButton.setAttribute('aria-pressed', String(follow));
    followButton.title = follow ? 'Follow ausschalten, um selbstständig zu blättern und zu scrollen.' : 'Zur aktuellen Seite und Scrollposition des Dozenten wechseln und ihnen weiter folgen.';
    const followLabel = document.createElement('span');
    followLabel.className = 'button-label';
    followLabel.textContent = 'Follow';
    followButton.append(followLabel);
    const indicator = document.createElement('span');
    indicator.className = 'connection-badge';
    indicator.dataset.state = state;
    indicator.title = labels[state];
    indicator.textContent = badges[state];
    toolbar.update([navigation, brand, context, pager, followButton, indicator], [
        {id: 'fullscreen', label: document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild', description: 'Browserleisten ausblenden, damit die Folie den ganzen Bildschirm nutzt.', icon: 'fullscreen', pressed: document.fullscreenElement !== null, disabled: !fullscreenAvailable, run: () => {
            void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen({navigationUI: 'hide'})).catch(error => notice(`Vollbild nicht möglich: ${String(error)}`));
        }},
        {id: 'note', label: notesLayer.placing ? 'Notiz setzen beenden' : 'Notiz setzen', description: notesLayer.placing ? 'Notizmodus beenden, ohne eine Notiz zu setzen.' : 'Danach auf die Seite tippen, um dort eine eigene Notiz zu setzen. Sie bleibt nur in diesem Browser.', icon: 'note', pressed: notesLayer.placing, disabled: !current, run: () => notesLayer.setPlacing(!notesLayer.placing)},
        {id: 'notes', label: `Meine Notizen (${notes.all.length})`, description: 'Alle eigenen Notizen ansehen, sichern oder aus einer Datei laden.', icon: 'notes', disabled: !notebook, run: notesDialog},
        {id: 'export', label: 'Aktuelles Thema als PDF exportieren', description: 'Alle Seiten dieses Themas mit PDF-Hintergründen und gespeicherter Handschrift als PDF herunterladen.', icon: 'download', disabled: !topic || exportController !== null, run: () => {void exportPdf();}},
        {id: 'zoom', label: `Zoom und Ansicht · ${zoom.label}`, description: 'Eigene Vergrößerung und Zoom-Sperre einstellen. Der Zoom des Dozenten wird nicht übernommen.', icon: 'zoom', run: zoomOptions},
        {id: 'zoom-lock', label: zoom.locked ? 'Zoom entsperren' : 'Zoom fixieren', description: zoom.locked ? 'Änderungen deiner Vergrößerung wieder erlauben.' : 'Deine Vergrößerung sperren, damit Zwei-Finger-Gesten sie nicht ändern.', icon: zoom.locked ? 'lock' : 'unlock', run: () => zoom.setLocked(!zoom.locked), pressed: zoom.locked},
        ...(privacyUrl ? [{id: 'privacy', label: 'Datenschutz', description: 'Datenschutzhinweise zu dieser Liveansicht in einem neuen Tab öffnen.', icon: 'info', run: () => { window.open(privacyUrl, '_blank', 'noopener,noreferrer'); }}] : []),
        ...(sourceUrl ? [{id: 'source', label: 'Quellcode', description: 'Den Quellcode dieser Liveansicht (AGPL-3.0) in einem neuen Tab öffnen.', icon: 'link', run: () => { window.open(sourceUrl, '_blank', 'noopener,noreferrer'); }}] : []),
        {id: 'placement', label: toolbar.preferences.floating ? 'Leiste oben andocken' : 'Leiste frei platzieren', description: toolbar.preferences.floating ? 'Navigation fest am oberen Fensterrand andocken.' : 'Navigation lösen und am Griff frei platzieren.', icon: toolbar.preferences.floating ? 'pin' : 'move', run: () => toolbar.toggleDock()},
    ]);
}
function drawer(): void {
    if (!notebook)
        return;
    const root = element('drawer');
    root.replaceChildren();
    const header = document.createElement('header');
    header.textContent = notebook.title;
    header.append(button('Drawer schließen', 'close', () => { root.hidden = true; }, 'Die linke Themenübersicht schließen.'));
    root.append(header);
    for (const topic of notebook.topics) {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'topic-button';
        node.title = `Thema „${topic.title}“ öffnen: ${topic.pages.length} Seiten. Eigene Navigation pausiert Follow.`;
        node.innerHTML = icon(topic.pages.some(page => page.background) ? 'pdf' : 'blank') + `<span>${escapeHtml(topic.title)}</span><small>${topic.pages.length}</small>`;
        if (topic.pages.some(page => page.id === current?.id))
            node.setAttribute('aria-current', 'page');
        node.addEventListener('click', () => choosePage(topic.pages[0]!));
        root.append(node);
    }
}
function dialog(title: string): HTMLDialogElement { const dialog = element<HTMLDialogElement>('viewer-dialog'); dialog.replaceChildren(); const header = document.createElement('header'), heading = document.createElement('h2'); heading.textContent = title; header.append(heading, button('Schließen', 'close', () => dialog.close())); dialog.append(header); return dialog; }
function turnPage(step: number): void {
    const pages = notebook?.topics.find(topic => topic.pages.some(page => page.id === current?.id))?.pages ?? [];
    const target = pages[pages.findIndex(page => page.id === current?.id) + step];
    if (target) choosePage(target);
}
async function exportPdf(): Promise<void> {
    const selected = notebook?.topics.find(topic => topic.pages.some(page => page.id === current?.id));
    if (!selected || exportController) return;
    // Capture the requested page list before Follow can switch topics.
    const topic = {...selected, pages: selected.pages.map(page => ({...page, strokes: []}))};
    const view = element<HTMLDialogElement>('export-dialog'), link = element<HTMLAnchorElement>('export-download');
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = null; link.hidden = true; link.removeAttribute('href');
    element('export-topic').textContent = topic.title;
    // With own notes on this topic, ask how to include them before building.
    const byPage: ExportNotes['byPage'] = new Map();
    for (const page of topic.pages) {
        const list = pageNotes(notes.all, page.id).map(({note, number}) => ({number, x: note.x, y: note.y, text: note.text, updated: note.updated}));
        if (list.length) byPage.set(page.id, list);
    }
    const options = element('export-options');
    options.hidden = byPage.size === 0;
    element('export-progress').textContent = '';
    if (byPage.size) {
        element<HTMLInputElement>('export-notes').checked = true;
        element<HTMLInputElement>('export-notes-print').checked = false;
        element<HTMLButtonElement>('export-start').onclick = () => {
            options.hidden = true;
            const comments = element<HTMLInputElement>('export-notes').checked, printable = element<HTMLInputElement>('export-notes-print').checked;
            void buildPdf(topic, comments || printable ? {byPage, comments, printable} : undefined);
        };
        view.showModal();
        return;
    }
    view.showModal();
    await buildPdf(topic);
}
async function buildPdf(topic: Topic, noteOptions?: ExportNotes): Promise<void> {
    if (exportController) return;
    const view = element<HTMLDialogElement>('export-dialog'), link = element<HTMLAnchorElement>('export-download');
    const controller = new AbortController(); exportController = controller;
    element('export-progress').textContent = 'PDF wird vorbereitet …';
    update();
    const read = async (path: string): Promise<Response> => {
        controller.signal.throwIfAborted();
        const timeout = window.setTimeout(() => controller.abort(), 30000);
        try {
            let response = await fetch(path, {signal: controller.signal, cache: 'no-store'});
            // Many students export at once after a lecture: wait briefly when the server is busy.
            for (let attempt = 0; response.status === 503 && attempt < 4; attempt++) {
                await new Promise(resolve => window.setTimeout(resolve, 1000 + attempt * 1500 + Math.random() * 1000));
                controller.signal.throwIfAborted();
                response = await fetch(path, {signal: controller.signal, cache: 'no-store'});
            }
            if (!response.ok) throw new Error(response.status === 429 || response.status === 503 ? 'Der Server ist gerade ausgelastet. Bitte den Export später erneut starten.' : 'Eine Seite konnte nicht geladen werden. Bitte den Export erneut starten.');
            // Read the body before clearing its timeout, including slow downloads.
            const data = await response.arrayBuffer();
            return new Response(data, {headers: response.headers});
        } finally {window.clearTimeout(timeout);}
    };
    try {
        const confirmed = await loadExportTopic(topic, async id => (await read(`/api/notebook/${identity}/page/${id}/export`)).json(),
            controller.signal, (done, total) => {element('export-progress').textContent = `Seiten laden: ${done} / ${total}`;});
        element('export-progress').textContent = 'PDF mit Hintergründen und Handschrift erzeugen …';
        const {exportTopicPdf} = await import('@livemitschrift/pdf/export');
        const bytes = await exportTopicPdf(confirmed, async (asset, page) => {
            controller.signal.throwIfAborted();
            return new Uint8Array(await (await read(`/api/notebook/${identity}/pdf/${asset}/page/${page ?? 1}`)).arrayBuffer());
        }, {pagewiseAssets: true, notes: noteOptions});
        controller.signal.throwIfAborted();
        exportUrl = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], {type: 'application/pdf'}));
        link.href = exportUrl; link.download = exportFilename(topic.title); link.hidden = false;
        element('export-progress').textContent = 'Dein PDF ist fertig.';
    } catch (error) {
        if (view.open) element('export-progress').textContent = controller.signal.aborted ? 'Export abgebrochen oder Zeitlimit überschritten. Bitte erneut starten.' : `PDF-Export fehlgeschlagen: ${String(error)}`;
    } finally {
        if (exportController === controller) exportController = null;
        update();
    }
}
/** All notes of this notebook by topic and page, with backup to and import from a file. */
function notesDialog(): void {
    if (!notebook) return;
    const view = dialog('Meine Notizen'), all = notes.all, list = document.createElement('div');
    list.className = 'notes-list';
    const intro = document.createElement('p');
    intro.textContent = all.length ? 'Nur in diesem Browser gespeichert. Sichere sie als Datei, um sie auf ein anderes Gerät mitzunehmen.' : 'Noch keine Notizen. Mit „Notiz setzen“ auf eine Stelle der Seite tippen.';
    const entry = (note: StudentNote, label: string, open: (() => void) | null): HTMLElement => {
        const row = document.createElement('div'), node = document.createElement(open ? 'button' : 'div');
        row.className = 'notes-row';
        node.className = 'notes-entry';
        const caption = document.createElement('small'), body = document.createElement('span');
        caption.textContent = label; body.textContent = [...note.text].slice(0, 140).join('');
        node.append(caption, body);
        if (open && node instanceof HTMLButtonElement) { node.type = 'button'; node.title = `${label} öffnen. Eigene Navigation pausiert Follow.`; node.addEventListener('click', open); }
        row.append(node, deleteButton(note, row));
        return row;
    };
    // Deleting asks once inline: the first tap arms the button, the second deletes.
    const deleteButton = (note: StudentNote, row: HTMLElement): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'notes-delete'; button.textContent = 'Löschen';
        button.title = 'Diese Notiz aus diesem Browser löschen. Zum Bestätigen ein zweites Mal tippen.';
        button.addEventListener('click', () => {
            if (button.dataset.armed !== 'true') {
                button.dataset.armed = 'true'; button.textContent = 'Wirklich löschen?';
                return;
            }
            try { notes.remove(note.id); } catch (error) { notice(`Notiz konnte nicht gelöscht werden: ${String(error)}`); return; }
            row.remove();
            notesLayer.render(current); update();
            backup.disabled = !notes.all.length;
        });
        return button;
    };
    const known = new Set<string>();
    for (const topic of notebook.topics) for (const [index, page] of topic.pages.entries()) {
        known.add(page.id);
        for (const {note, number} of pageNotes(all, page.id))
            list.append(entry(note, `${topic.title} · Seite ${index + 1} · Notiz ${number}`, () => { view.close(); choosePage(page); notesLayer.show(note, number); }));
    }
    const orphaned = all.filter(note => !known.has(note.pageId));
    for (const note of orphaned) list.append(entry(note, 'Entfernte Seite', null));
    const actions = document.createElement('div'), backup = document.createElement('button'), load = document.createElement('button'), file = document.createElement('input');
    actions.className = 'dialog-actions';
    backup.type = 'button'; backup.textContent = 'Notizen speichern'; backup.title = 'Alle Notizen dieses Notizbuchs als Datei herunterladen.'; backup.disabled = !all.length;
    backup.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([serializeNotes(notes.all, notebook?.title ?? '')], {type: 'application/json'}));
        const link = document.createElement('a');
        link.href = url; link.download = exportFilename(`${notebook?.title ?? 'Notizbuch'} – Notizen`).replace(/\.pdf$/, '.json');
        link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
    load.type = 'button'; load.textContent = 'Notizen laden'; load.title = 'Notizen aus einer gespeicherten Datei übernehmen; vorhandene bleiben erhalten.';
    load.addEventListener('click', () => file.click());
    file.addEventListener('change', () => { void (async () => {
        const chosen = file.files?.[0];
        if (!chosen) return;
        try {
            if (chosen.size > 4_000_000) throw new Error('Die Datei ist zu groß.');
            const result = mergeNotes(notes.all, parseNotes(await chosen.text()));
            notes.replace(result.notes);
            view.close(); notesLayer.render(current); update();
            notice(`${result.added} Notizen übernommen, ${result.updated} aktualisiert.`);
        } catch (error) { notice(`Notizen konnten nicht geladen werden: ${String(error)}`); }
    })(); });
    actions.append(load, backup, file);
    view.append(intro, list, actions);
    view.showModal();
}
function zoomOptions(): void {
    const view = dialog('Ansicht'); view.append(zoomControls(zoom)); view.showModal();
}
function pagePicker(pages: NotePage[], index: number): void {
    const view = dialog('Seiten'), label = document.createElement('label');
    label.textContent = `Seite (1–${pages.length})`;
    const jump = document.createElement('input');
    jump.type = 'number';
    jump.min = '1';
    jump.max = String(pages.length);
    jump.value = String(index + 1);
    jump.title = 'Seitennummer eingeben und mit Enter öffnen. Eigene Navigation pausiert Follow.';
    label.append(jump);
    view.append(label);
    jump.addEventListener('keydown', event => { if (event.key === 'Enter') {
        const number = Number(jump.value);
        if (Number.isInteger(number) && number >= 1 && number <= pages.length) {
            view.close();
            choosePage(pages[number - 1]!);
        }
    } });
    const previews = new PageThumbnails(view, readPdf, true, async page => {
        const response = await fetch(`/api/notebook/${identity}/page/${page.id}/preview`);
        if (!response.ok) throw new Error('Vorschau nicht verfügbar.');
        const value: unknown = await response.json();
        if (!validSyncPage(value) || value.id !== page.id) throw new Error('Ungültige Vorschau.');
        return value;
    });
    view.addEventListener('close', () => previews.dispose(), { once: true });
    const grid = document.createElement('div');
    grid.className = 'thumbnails';
    for (const [i, page] of pages.entries()) {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'thumbnail';
        if (i === index)
            node.setAttribute('aria-current', 'page');
        node.setAttribute('aria-label', `Seite ${i + 1}`);
        node.title = `Seite ${i + 1} öffnen. Eigene Navigation pausiert Follow.`;
        const preview = document.createElement('canvas');
        previews.add(preview, page);
        node.append(preview, document.createTextNode(String(i + 1)));
        node.addEventListener('click', () => { view.close(); choosePage(page); });
        grid.append(node);
    }
    view.append(grid);
    view.showModal();
}
function receive(message: NotebookSnapshot | NotebookEvent): void {
    if (message.type === 'notebook') {
        const previous = current?.id ?? (typeof saved.pageId === 'string' ? saved.pageId : null);
        notebook = message.notebook;
        position = message.position;
        if (follow) {
            display(findPage(notebook, position.pageId), position.y);
            followPosition();
        }
        else
            display(notebookPages(notebook).find(page => page.id === previous) ?? findPage(notebook, position.pageId));
        document.title = `${notebook.title} · LiveMitschrift`;
        persist(); return;
    }
    if (!notebook)
        return;
    applyNotebookEvent(notebook, message);
    if (message.type === 'pointer') {
        if (current?.id === message.pageId) laser.move(message.point);
        return;
    }
    if (message.type === 'viewport') {
        position = message.position;
        if (follow)
            followPosition();
        return;
    }
    const pageId = message.type === 'edit' ? message.edit.pageId : message.pageId;
    if (current?.id !== pageId)
        return;
    current = findPage(notebook, pageId);
    if (message.type === 'ink') {
        const change = ink.apply(message.operation);
        if (change)
            renderer.draw(change.stroke, change.from);
        // Repaint once to remove translucent seams between live marker segments.
        else if (message.operation.type === 'stroke_end' && ink.strokes.get(message.operation.stroke_id)?.highlighter)
            renderer.redraw();
    }
    else if (message.type === 'edit') {
        // Pasted ink can extend the page; keep the paper as tall as the edit.
        if (current.height !== pageSize.height) { pageSize.height = current.height; sizePaper(); }
        ink.replace({ type: 'snapshot', page: pageSize, strokes: current.strokes });
        renderer.invalidate();
    }
    else {
        pageSize.height = current.height;
        sizePaper();
        renderer.redraw();
    }
    // Markers are placed relative to the page height.
    if (message.type !== 'ink') notesLayer.render(current);
    if (message.type !== 'ink' || message.operation.type !== 'stroke_points')
        update();
}
const url = new URL(`/ws/notebook/v2/view/${identity}`, location.href);
url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const connection = new PagedConnection(url, receive, page => {
    if (!notebook || current?.id !== page.id) return;
    for (const topic of notebook.topics) {
        const index = topic.pages.findIndex(item => item.id === page.id);
        if (index >= 0) topic.pages[index] = page;
    }
    display(page, positions[page.id] ?? 0, false);
    if (follow) followPosition();
}, next => { state = next; if (next !== 'live') laser.clear(); update(); if (next === 'live')
    element('notice').hidden = true;
else if (next === 'error')
    notice('Das Notizbuch konnte nicht geladen werden. Bitte den Link prüfen und erneut öffnen.'); }, loading => {paper.dataset.loading = String(loading); paper.setAttribute('aria-busy', String(loading));});
element('follow-return').addEventListener('click', () => { follow = true; followPosition(); update(); persist(); });
element('notice-close').addEventListener('click', () => { element('notice').hidden = true; });
element('export-close').addEventListener('click', () => element<HTMLDialogElement>('export-dialog').close());
element('export-dialog').addEventListener('close', () => {
    exportController?.abort();
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = null;
});
viewport.addEventListener('wheel', event => {if (!event.ctrlKey) pauseFollow();}, {passive: true});
// Actual scrolling pauses Follow (scroll listener below); a plain tap does not.
// A horizontal swipe changes the page when the page fits the screen width.
let swipe: {x: number; y: number; time: number} | null = null;
viewport.addEventListener('touchstart', event => {
    const touch = event.touches[0];
    swipe = event.touches.length === 1 && touch ? {x: touch.clientX, y: touch.clientY, time: Date.now()} : null;
}, {passive: true});
viewport.addEventListener('touchend', event => {
    const touch = event.changedTouches[0], start = swipe; swipe = null;
    if (!start || !touch || viewport.scrollWidth > viewport.clientWidth + 1 || Date.now() - start.time > 600) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < Math.abs(dx) / 2) turnPage(dx < 0 ? 1 : -1);
}, {passive: true});
document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || (event.target as Element).closest('input,select,textarea,dialog')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); turnPage(event.key === 'ArrowRight' ? 1 : -1); }
});
document.addEventListener('fullscreenchange', () => { update(); sizePaper(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') connection.wake(); });
window.addEventListener('online', () => connection.wake());
viewport.addEventListener('pointerdown', event => { if (event.target === viewport)
    pauseFollow(); });
viewport.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key))
    pauseFollow(); });
viewport.addEventListener('scroll', () => { if (follow && Date.now() > ignoreScrollUntil)
    pauseFollow(); }, { passive: true });
new ResizeObserver(() => { sizePaper(); if (follow)
    followPosition(); }).observe(viewport);
window.addEventListener('pagehide', () => { exportController?.abort(); if (exportUrl) URL.revokeObjectURL(exportUrl); persist(); connection.stop(); });
window.addEventListener('pageshow', event => { if (event.persisted)
    connection.start(); });
window.addEventListener('error', event => notice(event.message));
window.addEventListener('unhandledrejection', event => notice(String(event.reason)));
sizePaper();
update();
connection.start();
