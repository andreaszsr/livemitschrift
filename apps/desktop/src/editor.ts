import { applyNotebookEvent, createStrokeId, DrawingSession, EditHistory, findPage, hitStroke, clampOffset, lassoSelection, pasteStrokes, strokeBounds, translateStrokes, InkDocument, LaserPointer, MAX_DOCUMENT_HEIGHT, MAX_PDF_BYTES, notebookPages, notebookPdfPlacement, PAGE_SIZE, PenInput, ViewportInkRenderer } from '@livemitschrift/core';
import type { InputHandlers, InputObservation, NotebookSnapshot, Notebook, NotePage, PageEdit, Topic, Point, Stroke, Vector, ViewPosition } from '@livemitschrift/core';
import { SelectionOverlay } from './selection-overlay.js';
import { loadPdfDocument, NotebookPdfRenderer, PageThumbnails } from '@livemitschrift/pdf';
import { button, escapeHtml, icon, Toolbar, toolbarPreferences, ViewportZoom, zoomControls } from '@livemitschrift/ui';
import type { ToolbarAction } from '@livemitschrift/ui';
import { NativePenInput, nativeInputAvailable } from './native-input.js';
import { closeApp, desktopStorageAvailable, openLiveViewer, readPdfAsset, storePdfAsset, toggleFullscreen } from './local-store.js';
import { encode as encodeQr } from 'uqr';
import { acknowledgeChanges, backupNotebook, createNotebook, createTopic, deleteNotebook, deleteTopic, editPage, forgetPublisherKey, insertBlankPage, loadLibrary, loadNotebook, loadPublisherKey, outgoingChanges, renameItem, reorderItems, restoreNotebook, chooseExportFolder, exportPdfToFolder, savePublisherKey, setPreference, syncCheckpoint, syncStatus, syncTarget } from './notebook-store.js';
import type { Library, NotebookLoad } from './notebook-store.js';
import { EditQueue } from './edit-queue.js';
import { defaultExportRange, exportFileName, parsePageRange, validExportFileName } from './export-options.js';
import { publisherKey, publisherServer, withdrawFromServer } from './publisher-access.js';
import { DeltaPublisher } from './delta-publisher.js';
import type { SharingState } from './sharing-state.js';
import { InputMetrics } from './input-metrics.js';
import { InputDiagnostics } from './input-diagnostics.js';
import { penPreferences, updatedWritingPins, writingActionIds } from './pen-presets.js';
import type { PenPreferences } from './pen-presets.js';
import { penPresetsForm } from './pen-presets-dialog.js';
import '@livemitschrift/ui/style.css';
function element<T extends HTMLElement>(id: string): T { const node = document.getElementById(id); if (!node)
    throw new Error(`Missing element: ${id}`); return node as T; }
function report(error: unknown): void { element('error-message').textContent = String(error); element('error').hidden = false; }
function parse(value: string | undefined): unknown { try {
    return value ? JSON.parse(value) : null;
}
catch {
    return null;
} }
type Tool = 'pen' | 'eraser' | 'highlighter' | 'laser' | 'lasso';
const TOOL_KEYS: Record<string, Tool> = {p: 'pen', e: 'eraser', h: 'highlighter', l: 'laser', s: 'lasso'};
const initialPage: NotePage = { id: 'local-page', title: 'Seite 1', ...PAGE_SIZE, background: null, strokes: [], nextOrder: 0 };
class Editor {
    private readonly persistent = desktopStorageAvailable();
    private library: Library = { notebooks: [{ id: 'local-document', title: 'Meine Notizen' }], preferences: {} };
    private loaded: NotebookLoad = { notebook: { id: 'local-document', title: 'Meine Notizen', topics: [{ id: 'local-topic', title: 'Mitschrift', pages: [structuredClone(initialPage)] }] }, secret: '' };
    private current = structuredClone(initialPage);
    private readonly pageSize = { ...PAGE_SIZE };
    private readonly ink = new InkDocument();
    private readonly viewport = element('viewport');
    private readonly paper = element('paper');
    private readonly canvas = element<HTMLCanvasElement>('page');
    private readonly renderer: ViewportInkRenderer;
    private readonly pdf: NotebookPdfRenderer;
    private readonly queue: EditQueue;
    private readonly session: DrawingSession;
    private readonly input: PenInput | NativePenInput;
    private readonly metrics = new InputMetrics();
    private readonly diagnostics: InputDiagnostics;
    private readonly toolbar: Toolbar;
    private publisher: DeltaPublisher | null = null;
    private sharing = false;
    private readonly publishers = new Map<string, DeltaPublisher>();
    private readonly enabledBooks = new Set<string>();
    private readonly modifiedTargets = new Set<string>();
    private readonly sharingServers = new Map<string,string>();
    private readonly serverKeys = new Map<string,string>();
    /**
     * What this session knows about the Keychain per server origin: the stored
     * key, or null when known to be absent. Every Keychain access of an ad-hoc
     * signed build may show a macOS prompt, so writes/deletes happen only when
     * they change something.
     */
    private readonly storedKeys = new Map<string,string|null>();
    private readonly sharingStates = new Map<string, SharingState>();
    private sharingState: SharingState = { phase: 'off', viewerUrl: null };
    private ready = false;
    private busy = false;
    private closing = false;
    private loadError: string | null = null;
    private tool: Tool = 'pen';
    private readonly laser: LaserPointer;
    private laserActive = false;
    private pendingPointer: {x: number; y: number} | null = null;
    private pointerTimer: number | undefined;
    private readonly selectionOverlay: SelectionOverlay;
    /** Lasso state: the selected strokes (as on the page), the path being drawn, an active move. */
    private selection: Stroke[] = [];
    private lassoPath: Point[] | null = null;
    private move: {start: Point; offset: Vector; frame: number | null} | null = null;
    /** App-internal clipboard; pasting works across pages and notebooks. */
    private clipboard: {strokes: Stroke[]; pageId: string; pastes: number} | null = null;
    private pen = penPreferences(null);
    private readonly writingIds = writingActionIds(this.pen);
    private histories = new Map<string, EditHistory>();
    private erased = new Map<string, Stroke>();
    private lastErase: Point | null = null;
    private structureTask: Promise<void> | null = null;
    private pendingPreferences = new Map<string, string>();
    private preferenceTimer: number | undefined;
    private preferenceTask: Promise<boolean> | null = null;
    private preferenceError: string | null = null;
    private positions: Record<string, number> = {};
    private readonly zoom: ViewportZoom;
    private temporaryEraser = false;
    private viewportTimer: number | undefined;
    private latestInput: InputObservation | null = null;
    private diagnosticsFrame: number | null = null;
    private minimum = Infinity;
    private maximum = -Infinity;
    constructor() {
        this.queue = new EditQueue(async edit => {if (this.persistent) await editPage(edit); this.publisher?.changed();}, () => this.status());
        this.renderer = new ViewportInkRenderer(this.canvas, this.paper, this.viewport, this.ink, this.pageSize, y => this.viewChanged(y));
        this.zoom = new ViewportZoom(this.paper, this.viewport, this.pageSize, {
            native: nativeInputAvailable(), enabled: () => this.ready && !this.busy && !this.closing,
            beforeChange: () => this.input?.finish(),
            changed: () => {this.preference('zoom-editor', JSON.stringify(this.zoom.preferences)); this.renderer.redraw(); this.viewChanged(this.renderer.visibleY); this.updateToolbar();},
            slideHeight: () => this.current.background ? notebookPdfPlacement(this.current.background).height : null,
        });
        this.laser = new LaserPointer(this.paper, this.pageSize);
        this.selectionOverlay = new SelectionOverlay(this.paper, this.pageSize);
        this.pdf = new NotebookPdfRenderer(element<HTMLCanvasElement>('pdf-background'), readPdfAsset, error => { element('pdf-status').textContent = String(error); report(`PDF-Darstellung fehlgeschlagen: ${String(error)}`); });
        this.toolbar = new Toolbar(element('toolbar'), this.writingIds, true,
            preferences => { this.preference('toolbar-writing', JSON.stringify(preferences)); this.updateToolbar(); },
            [{id: 'pen-presets', label: 'Farben & Strichdicken bearbeiten', icon: 'pen', run: () => this.penOptions()}]);
        const panels = new ResizeObserver(() => this.positionPanels());
        panels.observe(element('toolbar'));
        panels.observe(element('tools-panel'));
        this.session = new DrawingSession(this.ink, (change, operation) => {
            if (change)
                this.renderer.draw(change.stroke, change.from);
            this.current.strokes = [...this.ink.strokes.values()];
            if (operation.type === 'stroke_end') {
                const stroke = this.ink.strokes.get(operation.stroke_id)!;
                this.queue.enqueue(this.history().record(this.current.id, this.current.height, [stroke], []));
                // Repaint once to remove translucent seams between live marker segments.
                if (stroke.highlighter) this.renderer.redraw();
            }
            this.publisher?.publish({ type: 'ink', pageId: this.current.id, operation });
            if (operation.type !== 'stroke_points')
                this.status();
        }, createStrokeId, () => this.drawingTool === 'highlighter'
            ? { color: this.pen.markerColor, width: this.pen.markerWidth, order: this.current.nextOrder++, highlighter: true }
            : { color: this.color, width: this.width, order: this.current.nextOrder++ });
        const handlers: InputHandlers = { enabled: () => this.ready && !this.busy && !this.closing, start: point => {
                this.metrics.accept([point], this.renderer.pixelsPerUnit, true);
                if (this.drawingTool === 'laser') { this.laserActive = true; this.pointer(point); }
                else if (this.drawingTool === 'lasso') this.lassoStart(point);
                else if (this.drawingTool === 'eraser') {
                    this.erased.clear();
                    this.lastErase = point;
                    this.erase(point);
                }
                else
                    this.session.start(point);
            }, points: points => { this.metrics.accept(points, this.renderer.pixelsPerUnit); if (this.laserActive)
                this.pointer(points.at(-1) ?? null);
            else if (this.move || this.lassoPath)
                this.lassoPoints(points);
            else if (this.drawingTool === 'eraser')
                for (const point of points)
                    this.erase(point);
            else
                this.session.append(points); }, end: () => this.finishGesture(), observe: observation => this.observe(observation), processed: ms => this.metrics.processed(ms), temporaryTool: tool => {this.temporaryEraser = tool === 'eraser'; this.status();} };
        const mapping = (x: number, y: number, pressure: number) => this.renderer.toPoint(x, y, pressure);
        this.input = nativeInputAvailable() ? new NativePenInput(this.canvas, this.viewport, this.pageSize, handlers, mapping) : new PenInput(this.canvas, this.pageSize, handlers, mapping);
        this.diagnostics = new InputDiagnostics(this.metrics, () => this.input.finish(), this.persistent && nativeInputAvailable(), enabled => this.preference('input-high-rate', String(enabled)), report);
        this.bind();
        this.updateToolbar();
        this.status();
        void this.restore();
    }
    private get drawingTool(): Tool {return this.temporaryEraser ? 'eraser' : this.tool;}
    private selectTool(tool: Tool): void {this.input.finish(); if (tool !== 'lasso') this.clearSelection(); this.tool = tool; this.status();}
    // ---- Lasso: select, move, copy/cut/paste/delete -------------------------
    private selectionBounds(): ReturnType<typeof strokeBounds> { return strokeBounds(this.selection); }
    private lassoStart(point: Point): void {
        const bounds = this.selectionBounds(), pad = 10;
        if (bounds && point.x >= bounds.left - pad && point.x <= bounds.right + pad && point.y >= bounds.top - pad && point.y <= bounds.bottom + pad) {
            this.move = {start: point, offset: {x: 0, y: 0}, frame: null};
            return;
        }
        this.clearSelection();
        this.lassoPath = [point];
        this.selectionOverlay.lasso(this.lassoPath);
    }
    private lassoPoints(points: Point[]): void {
        const last = points.at(-1);
        if (!last) return;
        if (this.lassoPath) { this.lassoPath.push(...points); this.selectionOverlay.lasso(this.lassoPath); return; }
        const move = this.move!;
        move.offset = clampOffset(this.selection, {x: last.x - move.start.x, y: last.y - move.start.y}, this.pageSize);
        // Preview by swapping moved copies into the ink map; the page's stroke
        // list keeps the originals until the move is committed. One repaint per frame.
        if (move.frame === null) move.frame = requestAnimationFrame(() => {
            move.frame = null;
            for (const stroke of translateStrokes(this.selection, move.offset)) this.ink.strokes.set(stroke.id, stroke);
            this.renderer.invalidate();
            this.selectionOverlay.select(strokeBounds(translateStrokes(this.selection, move.offset)));
        });
    }
    private lassoEnd(): void {
        if (this.lassoPath) {
            const path = this.lassoPath; this.lassoPath = null;
            this.selection = lassoSelection(this.current.strokes, path);
            this.selectionOverlay.select(this.selectionBounds());
        } else if (this.move) {
            const move = this.move; this.move = null;
            if (move.frame !== null) cancelAnimationFrame(move.frame);
            if (Math.hypot(move.offset.x, move.offset.y) < .5) { this.redrawPage(); this.selectionOverlay.select(this.selectionBounds()); return; }
            // A move is "remove the originals, insert moved copies with the same
            // identities", which storage, server and viewers already support.
            const moved = translateStrokes(this.selection, move.offset);
            this.commitEdit(this.history().record(this.current.id, this.current.height, moved, this.selection));
            this.selection = this.current.strokes.filter(stroke => moved.some(item => item.id === stroke.id));
            this.selectionOverlay.select(this.selectionBounds());
        }
    }
    private clearSelection(): void {
        if (this.move) { if (this.move.frame !== null) cancelAnimationFrame(this.move.frame); this.move = null; this.redrawPage(); }
        this.selection = []; this.lassoPath = null; this.selectionOverlay.clear();
    }
    private redrawPage(): void {
        this.ink.replace({ type: 'snapshot', page: this.pageSize, strokes: this.current.strokes });
        this.current.strokes = [...this.ink.strokes.values()];
        this.renderer.invalidate();
    }
    /** Apply a local edit like undo/redo does: page model, ink, durable queue and live viewers. */
    private commitEdit(edit: PageEdit): void {
        applyNotebookEvent(this.notebook, { type: 'edit', edit });
        this.redrawPage();
        this.queue.enqueue(edit);
        this.publisher?.publish({ type: 'edit', edit });
        this.status();
    }
    private copySelection(cut: boolean): void {
        if (!this.selection.length || !this.ready || this.busy) return;
        this.clipboard = {strokes: structuredClone(this.selection), pageId: this.current.id, pastes: 0};
        if (cut) this.deleteSelection();
    }
    private deleteSelection(): void {
        if (!this.selection.length || !this.ready || this.busy) return;
        this.commitEdit(this.history().record(this.current.id, this.current.height, [], this.selection));
        this.clearSelection();
    }
    private paste(): void {
        const clipboard = this.clipboard;
        if (!clipboard || !this.ready || this.busy || this.closing) return;
        this.input.finish();
        // Same page: offset each paste so copies do not hide the original.
        const step = clipboard.pageId === this.current.id ? 24 * ++clipboard.pastes : 0;
        // Grow the writing space when the copied ink reaches below this page.
        let lowest = 0;
        for (const stroke of clipboard.strokes) for (const point of stroke.points) lowest = Math.max(lowest, point.y + step);
        if (lowest > this.current.height) {
            this.current.height = Math.min(MAX_DOCUMENT_HEIGHT, Math.ceil(lowest) + 200);
            this.pageSize.height = this.current.height;
            this.sizePaper();
        }
        const pasted = pasteStrokes(clipboard.strokes, {x: step, y: step}, this.pageSize, this.current.nextOrder, createStrokeId);
        this.current.nextOrder += pasted.length;
        this.commitEdit(this.history().record(this.current.id, this.current.height, pasted, []));
        this.clearSelection();
        this.tool = 'lasso';
        this.selection = this.current.strokes.filter(stroke => pasted.some(item => item.id === stroke.id));
        this.selectionOverlay.select(this.selectionBounds());
        this.status();
    }
    /**
     * The laser pointer is local UI plus a transient network message. Positions
     * are coalesced to ~30 Hz; hiding is sent immediately. Pressure is dropped
     * because the wire format carries document x/y only.
     */
    private pointer(point: {x: number; y: number} | null): void {
        this.laser.move(point);
        this.pendingPointer = point ? {x: point.x, y: point.y} : null;
        if (point && this.pointerTimer !== undefined) return;
        window.clearTimeout(this.pointerTimer);
        const send = (): void => { this.pointerTimer = undefined; this.publisher?.publish({type: 'pointer', pageId: this.current.id, point: this.pendingPointer}); };
        if (point) this.pointerTimer = window.setTimeout(send, 33); else send();
    }
    private turnPage(step: number): void {
        const pages = this.notebook.topics.find(topic => topic.pages.some(page => page.id === this.current.id))?.pages ?? [];
        const target = pages[pages.findIndex(page => page.id === this.current.id) + step];
        if (target) this.run(() => this.selectPage(target.id));
    }
    private get color(): string {return this.pen.color;}
    private get width(): number {return this.pen.width;}
    private get notebook(): Notebook { return this.loaded.notebook; }
    private history(): EditHistory { let history = this.histories.get(this.current.id); if (!history) {
        history = new EditHistory();
        this.histories.set(this.current.id, history);
    } return history; }
    private bind(): void {
        element<HTMLInputElement>('backup-file').addEventListener('change', event => {
            const field = event.currentTarget as HTMLInputElement, file = field.files?.[0]; field.value='';
            if (file) this.run(async () => {
                if (file.size > 120_000_000) throw new Error('Die Sicherung darf höchstens 120 MB groß sein.');
                await this.requireSaved();
                const id = await restoreNotebook(new Uint8Array(await file.arrayBuffer()));
                this.library = await loadLibrary(); await this.selectNotebook(id);
            });
        });
        element<HTMLInputElement>('pdf-file').addEventListener('change', event => { const field = event.currentTarget as HTMLInputElement, file = field.files?.[0]; field.value = ''; if (file)
            this.run(() => this.importPdf(file)); });
        element('storage-retry').addEventListener('click', () => { if (!this.ready)
            void this.restore();
        else
            void (async () => { await this.queue.flush(); await this.flushPreferences(); this.status(); })(); });
        element('discard-close').addEventListener('click', () => { void closeApp().catch(report); });
        element('error-close').addEventListener('click', () => { element('error').hidden = true; });
        window.addEventListener('livemitschrift-close-request', () => { void this.prepareClose(); });
        window.addEventListener('pagehide', () => { this.input.finish(); for (const publisher of this.publishers.values()) publisher.stop(); });
        for (const node of document.querySelectorAll('[data-close-dialog]'))
            node.addEventListener('click', () => node.closest('dialog')?.close());
        element('share-server').addEventListener('change',()=>{void this.fillPublisherKey();});
        element('share-load-key').addEventListener('click', () => {void this.fillPublisherKey(true);});
        element('share-copy').addEventListener('click', () => {void this.copyViewerLink();});
        element('share-qr').addEventListener('click', () => this.showQr());
        element('share-toggle').addEventListener('click', () => this.run(async () => {
            const id = this.notebook.id, wasSharing=this.sharing, server = element<HTMLInputElement>('share-server').value;
            this.modifiedTargets.add(id);
            await this.requireSaved();
            if (wasSharing) {
                await syncTarget(id,server,false); this.enabledBooks.delete(id); this.publisher?.stop(); this.sharing=false;
            } else {
                const key=publisherKey(element<HTMLInputElement>('share-key').value.trim()), origin=publisherServer(server).origin;
                const stored=this.storedKeys.get(origin);
                if (element<HTMLInputElement>('share-remember').checked) {
                    if (stored!==key) {await savePublisherKey(server,key); this.storedKeys.set(origin,key);}
                } else if (stored!==null) {await forgetPublisherKey(server); this.storedKeys.set(origin,null);}
                this.serverKeys.set(origin,key);
                this.publisher?.start(server,key);
                try {await syncTarget(id,server,true);} catch(error) {this.publisher?.stop(); throw error;}
                this.enabledBooks.add(id); this.sharingServers.set(id,server); this.sharing=true;
            }
            this.preference('server',server); this.updateSharing(); this.status();
        }));
        element<HTMLAnchorElement>('viewer-link').addEventListener('click', event => { if (this.persistent) {
            event.preventDefault();
            void openLiveViewer((event.currentTarget as HTMLAnchorElement).href).catch(report);
        } });
        window.addEventListener('keydown', event => {
            if ((event.target as Element).closest('input,select,textarea,dialog'))
                return;
            if (event.key === 'Escape' && (!element('tools-panel').hidden || !element('drawer').hidden)) {
                const tools = !element('tools-panel').hidden;
                element('tools-panel').hidden = true; element('drawer').hidden = true;
                this.updateToolbar();
                document.querySelector<HTMLButtonElement>(tools ? '#toolbar [data-action=tools]' : '#toolbar [aria-controls=drawer]')?.focus();
                return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                this.undoRedo(event.shiftKey);
            }
            const clip = (event.metaKey || event.ctrlKey) && !event.altKey ? event.key.toLowerCase() : '';
            if ((clip === 'c' || clip === 'x') && this.selection.length) { event.preventDefault(); this.copySelection(clip === 'x'); return; }
            if (clip === 'v' && this.clipboard) { event.preventDefault(); this.paste(); return; }
            if ((event.key === 'Backspace' || event.key === 'Delete') && this.selection.length) { event.preventDefault(); this.deleteSelection(); return; }
            if (event.key === 'Escape' && this.selection.length) { this.clearSelection(); return; }
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
                return;
            // Presenter remotes and tablet ExpressKeys usually send these keys.
            const step = ({ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1} as Record<string, number>)[event.key];
            if (step) {
                event.preventDefault();
                this.turnPage(step);
                return;
            }
            const tool = TOOL_KEYS[event.key.toLowerCase()];
            if (tool) this.selectTool(tool);
            else if (event.key.toLowerCase() === 'f' && this.persistent) void toggleFullscreen().catch(report);
        });
        this.viewport.addEventListener('wheel', event => {if (!event.ctrlKey) this.input.finish();}, { passive: true });
        new ResizeObserver(() => this.sizePaper()).observe(this.viewport);
    }
    private async restore(): Promise<void> {
        if (this.ready || this.busy)
            return;
        this.busy = true;
        this.loadError = null;
        this.status();
        try {
            if (this.persistent) {
                this.library = await loadLibrary();
                const stored = this.library.preferences.notebookId, id = this.library.notebooks.find(book => book.id === stored)?.id ?? this.library.notebooks[0]?.id;
                if (!id)
                    throw new Error('Keine lokalen Notizbücher gefunden.');
                this.loaded = await loadNotebook(id);
            }
            const savedPositions = parse(this.library.preferences.positions);
            if (savedPositions && typeof savedPositions === 'object')
                for (const [id, y] of Object.entries(savedPositions))
                    if (typeof y === 'number' && Number.isFinite(y) && y >= 0)
                        this.positions[id] = y;
            element<HTMLInputElement>('share-server').value = this.library.preferences.server ?? 'http://127.0.0.1:8000';
            this.pen = penPreferences(parse(this.library.preferences['pen-presets']));
            this.writingIds.splice(0, this.writingIds.length, ...writingActionIds(this.pen));
            const previousLayout = toolbarPreferences(parse(this.library.preferences['toolbar-editor']), this.writingIds, true);
            const toolbarPreference = parse(this.library.preferences['toolbar-writing']) ?? {...previousLayout, pinned: [...this.writingIds]};
            this.toolbar.configure(toolbarPreference);
            this.preference('toolbar-writing', JSON.stringify(this.toolbar.preferences));
            this.zoom.configure(parse(this.library.preferences['zoom-editor']));
            this.preference('zoom-editor', JSON.stringify(this.zoom.preferences));
            const selected = notebookPages(this.notebook).find(page => page.id === this.library.preferences.pageId) ?? notebookPages(this.notebook)[0]!;
            await this.diagnostics.configure(this.library.preferences['input-high-rate'] !== 'false').catch(report);
            this.ready = true;
            this.attachPublisher();
            this.display(selected);
            void this.resumeSharing(this.library.syncTargets ?? []);
        }
        catch (error) {
            this.loadError = String(error);
            report(`Laden fehlgeschlagen: ${String(error)}`);
        }
        finally {
            this.busy = false;
            this.status();
        }
    }
    /** Credential prompts must never hold the offline editor's startup busy. */
    private async resumeSharing(targets: {notebookId:string;server:string}[]): Promise<void> {
            for (const target of targets) {
                if (this.closing) return;
                if (this.modifiedTargets.has(target.notebookId)) continue;
                try {
                    this.sharingServers.set(target.notebookId,target.server);
                    const key=this.serverKeys.get(publisherServer(target.server).origin) ?? await loadPublisherKey(target.server);
                    if (key) this.storedKeys.set(publisherServer(target.server).origin,key);
                    if (this.closing) return;
                    if (this.modifiedTargets.has(target.notebookId)) continue;
                    if (!key) {this.sharingStates.set(target.notebookId,{phase:'error',viewerUrl:null,detail:'Schlüssel benötigt: Unter Teilen den gespeicherten Schlüssel laden oder den Zugangsschlüssel eintragen. Die Mitschrift bleibt lokal gespeichert.'});continue;}
                    const loaded = target.notebookId === this.notebook.id ? this.loaded : await loadNotebook(target.notebookId);
                    if (this.closing || this.modifiedTargets.has(target.notebookId)) continue;
                    this.serverKeys.set(publisherServer(target.server).origin,key);
                    this.enabledBooks.add(target.notebookId);this.sharingServers.set(target.notebookId,target.server);
                    this.publisherFor(loaded).start(target.server,key);
                } catch(error) {
                    this.sharingStates.set(target.notebookId,{phase:'error',viewerUrl:null,detail:`Synchronisation nicht gestartet: ${String(error)}`});
                }
            }
            if (!this.closing) this.attachPublisher();
    }
    private publisherFor(loaded: NotebookLoad): DeltaPublisher {
        const id = loaded.notebook.id;
        let publisher = this.publishers.get(id);
        if (!publisher) {
            const snapshot = (): NotebookSnapshot => ({type:'notebook',notebook:this.notebook.id===id ? this.notebook : loaded.notebook,
                position:this.notebook.id===id ? this.position() : {pageId:notebookPages(loaded.notebook)[0]!.id,y:0}});
            const state = (state: SharingState): void => {
                this.sharingStates.set(id,state);
                if (this.notebook.id===id) {this.sharingState=state;this.updateSharing();this.updateToolbar();}
            };
            publisher = new DeltaPublisher(snapshot, loaded.secret, readPdfAsset, state, {status:()=>syncStatus(id),checkpoint:()=>syncCheckpoint(id),outgoing:after=>outgoingChanges(id,after),acknowledge:sequence=>acknowledgeChanges(id,sequence),preview:()=>this.notebook.id===id ? snapshot() : null});
            this.publishers.set(id,publisher);
        }
        return publisher;
    }
    private attachPublisher(): void {
        this.publisher = this.publisherFor(this.loaded);
        this.sharing = this.enabledBooks.has(this.notebook.id);
        if (this.sharingServers.has(this.notebook.id)) element<HTMLInputElement>('share-server').value=this.sharingServers.get(this.notebook.id)!;
        this.sharingState = this.sharingStates.get(this.notebook.id) ?? {phase:'off',viewerUrl:null};
        this.updateSharing();
    }
    private async requireSaved(): Promise<void> {
        if (!await this.queue.flush()) throw new Error('Bitte zuerst die ausstehenden Änderungen lokal speichern.');
    }
    /**
     * Export dialog for the current topic: a remembered folder per notebook, an
     * editable file name and a page range that defaults to the pages written
     * since the previous export of this topic, up to the visible page.
     */
    private exportDialog(): void {
        if (!this.ready || this.busy || this.closing) return;
        const topic = this.notebook.topics.find(topic => topic.pages.some(page => page.id === this.current.id))!;
        const pages = topic.pages, current = pages.findIndex(page => page.id === this.current.id) + 1;
        const folderKey = `export-folder:${this.notebook.id}`, lastKey = `export-last:${topic.id}`;
        const last = pages.findIndex(page => page.id === this.library.preferences[lastKey]) + 1 || null;
        let folder = this.library.preferences[folderKey] || null;
        const dialog = this.dialog('PDF exportieren'), form = document.createElement('form');
        form.className = 'export-form';
        const field = (text: string, input: HTMLElement): HTMLLabelElement => { const label = document.createElement('label'); label.textContent = text; label.append(input); return label; };

        const folderRow = document.createElement('div'), folderText = document.createElement('span'), chooseFolder = document.createElement('button');
        folderRow.className = 'export-folder';
        chooseFolder.type = 'button'; chooseFolder.textContent = 'Ordner wählen …'; chooseFolder.dataset.action = 'export-folder';
        chooseFolder.title = 'Ordner für die PDF-Exporte dieses Notizbuchs wählen, z. B. in Nextcloud. Er wird gemerkt.';
        const showFolder = (): void => { folderText.textContent = folder ?? 'Noch kein Ordner gewählt'; folderText.title = folder ?? ''; };
        const pickFolder = async (): Promise<boolean> => {
            const chosen = await chooseExportFolder(folder);
            if (!chosen) return false;
            folder = chosen; this.preference(folderKey, chosen); showFolder(); return true;
        };
        chooseFolder.addEventListener('click', () => { void pickFolder().catch(error => { message.textContent = String(error); }); });
        showFolder();
        folderRow.append(folderText, chooseFolder);

        const name = document.createElement('input');
        name.name = 'export-name'; name.required = true; name.maxLength = 204;
        name.value = exportFileName(this.notebook.title, topic.title, new Date());
        name.title = 'Dateiname ohne „.pdf“. Vorgabe: Notizbuch_Thema-Datum.';

        const scope = document.createElement('fieldset'), legend = document.createElement('legend'), range = document.createElement('input');
        legend.textContent = 'Seiten';
        const choice = (value: string, text: string, help: string): HTMLInputElement => {
            const radio = document.createElement('input'), label = document.createElement('label');
            radio.type = 'radio'; radio.name = 'export-scope'; radio.value = value; radio.title = help;
            label.className = 'export-choice'; label.append(radio, document.createTextNode(text));
            scope.append(label); return radio;
        };
        scope.append(legend);
        const all = choice('all', `Alle Seiten (${pages.length})`, 'Alle Seiten des aktuellen Themas exportieren.'),
            partial = choice('range', 'Bereich', 'Nur die Seiten im Eingabefeld exportieren.');
        partial.checked = true;
        range.name = 'export-range'; range.value = defaultExportRange(last, current);
        range.title = 'Seiten des Themas, z. B. 2-5,7. Vorgabe: ab der Seite nach dem letzten Export bis zur aktuellen Seite.';
        range.addEventListener('focus', () => { partial.checked = true; });
        partial.parentElement!.append(range);
        const hint = document.createElement('p');
        hint.textContent = `Aktuelle Seite: ${current} von ${pages.length}` + (last ? ` · zuletzt exportiert bis Seite ${last}` : '');
        scope.append(hint);

        const message = document.createElement('p'); message.className = 'export-message'; message.setAttribute('role', 'status');
        const actions = document.createElement('div'), cancel = document.createElement('button'), submit = document.createElement('button');
        actions.className = 'dialog-actions';
        cancel.type = 'button'; cancel.textContent = 'Schließen'; cancel.title = 'Export-Dialog schließen.'; cancel.addEventListener('click', () => dialog.close());
        submit.type = 'submit'; submit.className = 'primary'; submit.textContent = 'Exportieren';
        submit.title = 'Die gewählten Seiten als PDF in den Exportordner speichern.';
        actions.append(cancel, submit);
        form.append(field('Ordner', folderRow), field('Dateiname (.pdf)', name), scope, message, actions);

        form.addEventListener('submit', event => {
            event.preventDefault();
            const fileName = validExportFileName(name.value);
            const selected = all.checked ? pages.map((_, index) => index + 1) : parsePageRange(range.value, pages.length);
            if (!fileName) { message.textContent = 'Ungültiger Dateiname: keine Zeichen wie / : ? * und nicht mit einem Punkt beginnen.'; return; }
            if (!selected) { message.textContent = `Ungültiger Bereich. Beispiel: 2-5,7 (Seiten 1 bis ${pages.length}).`; return; }
            if (this.busy) { message.textContent = 'Bitte kurz warten und erneut versuchen.'; return; }
            submit.disabled = true;
            message.textContent = 'PDF wird erstellt …';
            this.run(async () => {
                try {
                    if (!folder && !await pickFolder()) { message.textContent = 'Bitte einen Exportordner wählen.'; return; }
                    const saved = await this.exportPdf({...topic, pages: selected.map(number => pages[number - 1]!)}, folder!, fileName);
                    if (!saved) { message.textContent = 'Nicht gespeichert.'; return; }
                    this.preference(lastKey, pages[selected.at(-1)! - 1]!.id);
                    message.textContent = `Gespeichert: ${fileName}.pdf`;
                } catch (error) {
                    message.textContent = `Export fehlgeschlagen: ${String(error)}`;
                } finally {
                    submit.disabled = false;
                }
            });
        });
        dialog.append(form);
        dialog.showModal();
        submit.focus();
    }
    /** Returns false if the user declined to replace an existing file. */
    private async exportPdf(topic: Topic, folder: string, name: string): Promise<boolean> {
        await this.requireSaved();
        const {exportTopicPdf} = await import('@livemitschrift/pdf/export');
        const pdf = await exportTopicPdf(topic, readPdfAsset);
        if (await exportPdfToFolder(folder, name, false, pdf) === 'saved') return true;
        if (!await this.confirmDelete('Datei ersetzen?', `„${name}.pdf“ gibt es im Exportordner bereits.`, undefined, 'Ersetzen')) return false;
        return await exportPdfToFolder(folder, name, true, pdf) === 'saved';
    }
    private manage(): void {
        const dialog=this.dialog('Notizbücher und Themen verwalten');
        const section=(heading:string,items:{id:string;title:string}[],book:string|null) => {
            const title=document.createElement('h3'); title.textContent=heading; dialog.append(title);
            for (const [index,item] of items.entries()) {
                const row=document.createElement('div'); row.className='management-row';
                const label=document.createElement('span');label.textContent=item.title; row.append(label);
                row.append(button(`${item.title} umbenennen`,'pen',()=>this.askTitle('Umbenennen',item.title,name=>this.run(async()=>{
                    await this.requireSaved(); await renameItem(book ?? item.id,item.id,name); await this.reloadMetadata(); this.manage();
                }),'Speichern')));
                for (const delta of [-1,1]) {
                    const move=button(`${item.title} nach ${delta<0?'oben':'unten'}`,delta<0?'up':'down',()=>this.run(async()=>{
                        await this.requireSaved(); const ids=items.map(item=>item.id); [ids[index],ids[index+delta]]=[ids[index+delta]!,ids[index]!];
                        await reorderItems(book,ids);await this.reloadMetadata();this.manage();
                    }));
                    move.disabled=index+delta<0||index+delta>=items.length; row.append(move);
                }
                const remove=button(`${item.title} löschen`,'trash',()=>book ? this.deleteTopicFlow(item.id,()=>this.manage()) : this.deleteNotebookFlow(item.id,()=>this.manage()),
                    book ? 'Dieses Thema mit allen Seiten und Handschrift löschen.' : 'Dieses Notizbuch mit allen Themen löschen.');
                remove.classList.add('danger'); remove.disabled=items.length<=1; row.append(remove);
                dialog.append(row);
            }
        };
        section('Notizbücher',this.library.notebooks,null);
        section(`Themen · ${this.notebook.title}`,this.notebook.topics,this.notebook.id);
        dialog.showModal();
    }
    private async reloadMetadata(): Promise<void> {
        const pageId=this.current.id; this.library=await loadLibrary();this.loaded=await loadNotebook(this.notebook.id);
        this.display(findPage(this.notebook,pageId));this.publisher?.changed();
    }
    private display(page: NotePage): void {
        if (this.laserActive || this.pendingPointer) this.pointer(null);
        this.laserActive = false; this.laser.clear();
        this.clearSelection();
        this.current = page;
        Object.assign(this.pageSize, { width: page.width, height: page.height });
        this.ink.replace({ type: 'snapshot', page: this.pageSize, strokes: page.strokes });
        page.strokes = [...this.ink.strokes.values()];
        this.sizePaper();
        this.viewport.scrollTop = (this.positions[page.id] ?? 0) * this.paper.getBoundingClientRect().width / page.width;
        this.renderer.invalidate();
        this.updateToolbar();
        this.drawer();
        element('pdf-status').textContent = page.background ? `${page.background.name} · Folie ${page.background.pageNumber}` : 'Kein PDF-Hintergrund';
        void this.pdf.set(page.background).catch(error => report(`PDF konnte nicht geladen werden: ${String(error)}`));
        this.preference('pageId', page.id);
        this.preference('notebookId', this.notebook.id);
    }
    private async selectPage(id: string): Promise<void> { if (!await this.queue.flush())
        throw new Error('Bitte die ausstehenden Änderungen zuerst speichern.'); this.display(findPage(this.notebook, id)); this.publisher?.publish({ type: 'viewport', position: { pageId: id, y: this.positions[id] ?? 0 } }); }
    private async selectNotebook(id: string): Promise<void> { if (!await this.queue.flush())
        throw new Error('Bitte die ausstehenden Änderungen zuerst speichern.'); const loaded = await loadNotebook(id); this.loaded = loaded; this.attachPublisher(); this.display(notebookPages(this.notebook)[0]!); }
    private run(action: () => Promise<void>): void {
        if (this.busy || !this.ready || this.closing)
            return;
        this.input.finish();
        this.busy = true;
        this.status();
        this.structureTask = action().catch(report).finally(() => { this.structureTask = null; this.busy = false; this.status(); if (!element('drawer').hidden)
            this.drawer(); });
    }
    private async importPdf(file: File): Promise<void> {
        if (file.size > MAX_PDF_BYTES)
            throw new Error(`Die PDF darf höchstens ${MAX_PDF_BYTES / 1_000_000} MB groß sein.`);
        if (!await this.queue.flush())
            throw new Error('Bitte die ausstehenden Änderungen zuerst speichern.');
        element('pdf-status').textContent = 'PDF wird geprüft …';
        const bytes = new Uint8Array(await file.arrayBuffer()), document = await loadPdfDocument(bytes);
        const metadata: Omit<NonNullable<NotePage['background']>, 'assetId'>[] = [];
        try {
            for (let number = 1; number <= document.numPages; number++) {
                const page = await document.getPage(number), size = page.getViewport({ scale: 1 });
                metadata.push({ name: [...file.name].slice(0, 200).join(''), pageNumber: number, width: size.width, height: size.height });
                page.cleanup();
            }
        }
        finally {
            await document.loadingTask.destroy();
        }
        const assetId = await storePdfAsset(bytes), name = [...file.name.replace(/\.pdf$/i, '')].slice(0, 200).join('') || 'PDF';
        const id = await createTopic(this.notebook.id, name, metadata.map(page => ({ ...page, assetId })));
        this.loaded = await loadNotebook(this.notebook.id);
        this.display(this.notebook.topics.find(topic => topic.id === id)!.pages[0]!);
        this.publisher?.refresh();
    }
    private finishGesture(): void { if (this.laserActive) { this.laserActive = false; this.pointer(null); } if (this.lassoPath || this.move) this.lassoEnd(); this.session.finish(); if (this.erased.size) {
        this.queue.enqueue(this.history().record(this.current.id, this.current.height, [], [...this.erased.values()]));
        this.erased.clear();
    } this.lastErase = null; this.status(); }
    private erase(point: Point): void {
        const from = this.lastErase ?? point, removed: Stroke[] = [];
        for (const stroke of this.ink.strokes.values())
            if (stroke.complete && hitStroke(stroke, from, point, 12 / this.renderer.pixelsPerUnit)) {
                removed.push(structuredClone(stroke));
                this.ink.strokes.delete(stroke.id);
            }
        this.lastErase = point;
        if (!removed.length)
            return;
        for (const stroke of removed)
            this.erased.set(stroke.id, stroke);
        this.current.strokes = [...this.ink.strokes.values()];
        this.renderer.invalidate();
        this.publisher?.publish({ type: 'edit', edit: { id: createStrokeId(), pageId: this.current.id, insert: [], remove: removed.map(stroke => stroke.id), height: this.current.height } });
        this.status();
    }
    private undoRedo(redo: boolean): void {
        if (!this.ready || this.busy || this.closing)
            return;
        this.input.finish();
        this.clearSelection();
        const edit = redo ? this.history().redo() : this.history().undo();
        if (!edit)
            return;
        applyNotebookEvent(this.notebook, { type: 'edit', edit });
        this.ink.replace({ type: 'snapshot', page: this.pageSize, strokes: this.current.strokes });
        this.current.strokes = [...this.ink.strokes.values()];
        this.queue.enqueue(edit);
        this.publisher?.publish({ type: 'edit', edit });
        this.renderer.invalidate();
        this.status();
    }
    private sizePaper(): void {this.zoom.resize();}
    private viewChanged(y: number): void {
        if (!this.ready || this.busy)
            return;
        this.positions[this.current.id] = Math.min(y, this.current.height);
        this.preference('positions', JSON.stringify(this.positions));
        this.schedulePosition();
        if (this.viewport.scrollTop + this.viewport.clientHeight > this.viewport.scrollHeight - 350 && this.current.height < MAX_DOCUMENT_HEIGHT) {
            this.current.height = Math.min(MAX_DOCUMENT_HEIGHT, this.current.height + 1600);
            this.pageSize.height = this.current.height;
            this.sizePaper();
            this.queue.enqueue({ id: createStrokeId(), pageId: this.current.id, insert: [], remove: [], height: this.current.height });
            this.publisher?.publish({ type: 'extent', pageId: this.current.id, height: this.current.height });
        }
    }
    private position(): ViewPosition {
        return { pageId: this.current.id, y: Math.min(this.current.height, this.renderer.visibleY) };
    }
    private schedulePosition(): void { if (this.viewportTimer === undefined)
        this.viewportTimer = window.setTimeout(() => { this.viewportTimer = undefined; this.publisher?.publish({ type: 'viewport', position: this.position() }); }, 80); }
    private preference(key: string, value: string): void { this.library.preferences[key] = value; if (!this.persistent)
        return; this.pendingPreferences.set(key, value); window.clearTimeout(this.preferenceTimer); this.preferenceTimer = window.setTimeout(() => { void this.flushPreferences(); }, 800); }
    private flushPreferences(): Promise<boolean> {
        window.clearTimeout(this.preferenceTimer);
        if (this.preferenceTask)
            return this.preferenceTask;
        this.preferenceError = null;
        this.preferenceTask = (async () => { try {
            while (this.pendingPreferences.size) {
                const [key, value] = this.pendingPreferences.entries().next().value!;
                await setPreference(key, value);
                if (this.pendingPreferences.get(key) === value)
                    this.pendingPreferences.delete(key);
            }
            return true;
        }
        catch (error) {
            this.preferenceError = String(error);
            report(`Ansicht konnte nicht gespeichert werden: ${String(error)}`);
            return false;
        } })().finally(() => { this.preferenceTask = null; this.status(); });
        return this.preferenceTask;
    }
    private status(): void {
        const state = this.queue.state, error = this.loadError ?? state.error ?? this.preferenceError, writing = [...this.ink.strokes.values()].some(stroke => !stroke.complete) || this.erased.size > 0, status = element('save-status');
        status.textContent = !this.persistent ? 'Browser-Vorschau · Nicht gespeichert' : this.loadError ? 'Seite konnte nicht geladen werden' : !this.ready ? 'Lokale Seite wird geladen …' : error ? `Nicht gespeichert · ${state.pending} ausstehend` : state.pending ? 'Wird lokal gespeichert …' : writing ? 'Aktueller Strich noch nicht gespeichert' : 'Lokal gespeichert';
        status.dataset.state = error ? 'error' : state.pending || writing ? 'pending' : 'ready';
        element('stroke-count').textContent = `${this.ink.strokes.size} ${this.ink.strokes.size === 1 ? 'Strich' : 'Striche'}`;
        const retry = element<HTMLButtonElement>('storage-retry');
        retry.hidden = !error;
        retry.disabled = state.saving || this.busy;
        if (error)
            report(`${this.loadError ? 'Laden' : 'Speichern'} fehlgeschlagen: ${error}`);
        this.paper.dataset.tool = this.drawingTool;
        this.updateToolbar();
        this.updateSharing();
    }
    private updateToolbar(): void {
        if (!this.toolbar)
            return;
        const disabled = !this.ready || this.busy || this.closing;
        const drawer = button('Notizbücher und Themen', 'drawer', () => this.togglePanel('drawer'));
        drawer.title = 'Linke Leiste öffnen oder schließen: Notizbuch und Thema auswählen oder verwalten.';
        drawer.setAttribute('aria-controls', 'drawer');
        drawer.setAttribute('aria-expanded', String(!element('drawer').hidden));
        drawer.disabled = disabled;
        const tools = button('Weitere Werkzeuge ein-/ausblenden', 'tools', () => this.togglePanel('tools-panel'));
        tools.title = 'Obere Werkzeugleiste öffnen oder schließen: PDFs, Teilen, Sicherungen und Einstellungen.';
        tools.dataset.action = 'tools';
        tools.disabled = disabled;
        tools.setAttribute('aria-controls', 'tools-panel');
        tools.setAttribute('aria-expanded', String(!element('tools-panel').hidden));
        const topic = this.notebook.topics.find(topic => topic.pages.some(page => page.id === this.current.id)), context = document.createElement('span');
        context.className = 'toolbar-context';
        context.textContent = topic?.title ?? 'Mitschrift';
        context.title = `${this.notebook.title} / ${context.textContent}`;
        const navigation = document.createElement('div');
        navigation.className = 'page-navigation';
        const pages = topic?.pages ?? [this.current], index = pages.findIndex(page => page.id === this.current.id);
        const previous = button('Vorherige Seite', 'left', () => this.run(() => this.selectPage(pages[index - 1]!.id)));
        previous.disabled = disabled || index <= 0;
        const count = document.createElement('button');
        count.type = 'button';
        count.className = 'page-count';
        count.textContent = `${index + 1} / ${pages.length}`;
        count.title = 'Seitenübersicht öffnen: Vorschau auswählen oder eine Seitennummer eingeben. Blättern auch mit ←/→ oder Bild auf/ab (Presenter).';
        count.setAttribute('aria-label', 'Seitenzahl und Miniaturen');
        count.disabled = disabled;
        count.addEventListener('click', () => { this.input.finish(); this.pagePicker(pages, index); });
        const next = button('Nächste Seite', 'right', () => this.run(() => this.selectPage(pages[index + 1]!.id)));
        next.disabled = disabled || index >= pages.length - 1;
        navigation.append(previous, count, next);
        const indicator = document.createElement('span');
        indicator.className = 'save-indicator';
        indicator.dataset.state = element('save-status').dataset.state ?? 'ready';
        indicator.title = element('save-status').textContent ?? 'Lokaler Speicherstatus';
        indicator.setAttribute('role', 'img');
        indicator.setAttribute('aria-label', indicator.title);
        const connectionLabels = {off:'Nur lokal',connecting:'Verbinde …',live:'Live verbunden',reconnecting:'Verbindung unterbrochen · Verbinde erneut …',error:'Synchronisation benötigt Aufmerksamkeit'};
        const connectionLabel = this.sharingState.detail ?? connectionLabels[this.sharingState.phase];
        const connection = button('Serververbindung und Teilen', 'link', () => this.openSharing(), `${connectionLabel} · Klicken öffnet die Verbindungseinstellungen.`);
        connection.dataset.connection = this.sharingState.phase;
        connection.className = 'connection-indicator';
        connection.setAttribute('aria-label', `Serververbindung: ${connectionLabel}`);
        connection.disabled = disabled || !this.persistent;
        const descriptions: Record<string, string> = {
            undo: 'Letzte Änderung auf dieser Seite rückgängig machen (⌘/Strg+Z).',
            redo: 'Zuletzt rückgängig gemachte Änderung wiederherstellen (⌘/Strg+Umschalt+Z).',
            pen: 'Mit der gewählten Farbe und Dicke schreiben (Taste P).',
            highlighter: 'Halbtransparent markieren, z. B. Text auf der Folie hervorheben (Taste H).',
            lasso: 'Striche einkreisen und auswählen (Taste S). Rahmen ziehen verschiebt; ⌘C/⌘X/⌘V kopieren, ausschneiden, einfügen; Entf löscht; Esc hebt auf.',
            laser: 'Laserpointer: zeigt beim Schreiben einen roten Punkt, der wieder verblasst – auch in der Browseransicht. Wird nicht gespeichert (Taste L).',
            fullscreen: 'Vollbild für Beamer ein- oder ausschalten (Taste F).',
            qr: 'Großen QR-Code mit dem Leselink zeigen, damit Studierende ihn vom Beamer abfotografieren können.',
            settings: 'Selten benötigte Funktionen: Sicherungen, Verwaltung, Farben, Leiste und Stifttest.',
            eraser: 'Berührte handschriftliche Striche vollständig entfernen. Der PDF-Hintergrund bleibt erhalten (Taste E).',
            import: 'Ein mehrseitiges PDF als neues Thema einfügen. Jede PDF-Seite erhält eine eigene beschreibbare Seite.',
            blank: 'Ein neues Thema mit einer leeren Schreibseite im aktuellen Notizbuch anlegen.',
            'blank-page': 'Direkt nach der aktuellen Seite eine leere Schreibseite einfügen.',
            zoom: 'Vergrößerung, Anpassung an die Fensterbreite und Zoom-Sperre einstellen.',
            'zoom-lock': this.zoom.locked ? 'Änderungen der Vergrößerung wieder erlauben.' : 'Aktuelle Vergrößerung sperren, damit Zwei-Finger-Gesten sie nicht versehentlich ändern.',
            share: 'Serververbindung einrichten und das gesamte Notizbuch über einen schreibgeschützten Browserlink teilen.',
            export: 'Das aktuelle Thema mit PDF-Hintergründen und Handschrift als PDF speichern.',
            backup: 'Das gesamte Notizbuch mit allen Themen, Seiten und PDFs als portable Sicherung speichern.',
            'restore-backup': 'Eine Sicherung als zusätzliches Notizbuch öffnen. Vorhandene Notizbücher bleiben erhalten.',
            placement: this.toolbar.preferences.floating ? 'Schreibleiste fest am oberen Fensterrand andocken.' : 'Schreibleiste lösen und am Griff frei auf der Schreibfläche platzieren.',
            diagnostics: 'Stiftgerät, Druck, Tasten und Eingabefrequenz prüfen.',
            manage: 'Notizbücher und Themen umbenennen oder ihre Reihenfolge ändern.',
            'pen-presets': 'Eigene Farben und Strichdicken hinzufügen, verändern oder aus den Favoriten entfernen.',
            customize: 'Werkzeuge sortieren und zwischen sichtbarer Leiste und dem „…“-Menü verschieben.',
        };
        const action = (id: string, label: string, name: string, run: () => void, extra: Partial<ToolbarAction> = {}): ToolbarAction => ({ id, label, description: descriptions[id], icon: name, run, disabled, ...extra });
        const marking = this.drawingTool === 'highlighter';
        this.toolbar.update([drawer, tools, context, navigation, indicator, connection], [
            action('undo', 'Rückgängig', 'undo', () => this.undoRedo(false), {disabled: disabled || !this.history().canUndo}),
            action('redo', 'Wiederholen', 'redo', () => this.undoRedo(true), {disabled: disabled || !this.history().canRedo}),
            action('pen', 'Stift', 'pen', () => this.selectTool('pen'), {pressed: this.drawingTool === 'pen'}),
            action('eraser', 'Ganze Striche radieren', 'eraser', () => this.selectTool('eraser'), {pressed: this.drawingTool === 'eraser'}),
            action('highlighter', 'Textmarker', 'marker', () => this.selectTool('highlighter'), {pressed: this.drawingTool === 'highlighter'}),
            action('lasso', 'Lasso', 'lasso', () => this.selectTool('lasso'), {pressed: this.drawingTool === 'lasso'}),
            action('laser', 'Laserpointer', 'laser', () => this.selectTool('laser'), {pressed: this.drawingTool === 'laser'}),
            this.blankPageAction(action),
            // While marking, the shared width/color slots show the marker presets.
            ...(marking ? this.pen.markerWidths.map((width, index) => action(`width-${index}`, `Markerdicke ${width.toLocaleString('de-DE')}`, 'marker',
                () => this.chooseMarker(this.pen.markerColor, width), {description: `Mit Markerdicke ${width.toLocaleString('de-DE')} weiter markieren.`, strokeWidth: width, pressed: this.pen.markerWidth === width}))
                : this.pen.widths.map((width, index) => action(`width-${index}`, `Strichdicke ${width.toLocaleString('de-DE')}`, 'pen',
                () => this.choosePen(this.color, width), {description: `Mit Strichdicke ${width.toLocaleString('de-DE')} weiterschreiben. Wählt gleichzeitig den Stift aus.`, strokeWidth: width, pressed: this.width === width}))),
            ...(marking ? this.pen.markerColors.map((color, index) => action(`color-${index}`, `Markerfarbe ${color}`, 'marker',
                () => this.chooseMarker(color, this.pen.markerWidth), {description: `Mit Markerfarbe ${color} weiter markieren.`, color, pressed: this.pen.markerColor === color}))
                : this.pen.colors.map((color, index) => action(`color-${index}`, `Stiftfarbe ${color}`, 'pen',
                () => this.choosePen(color, this.width), {description: `Mit Farbe ${color} weiterschreiben. Wählt gleichzeitig den Stift aus.`, color, pressed: this.color === color}))),
        ]);
        const settings = [
            action('backup', 'Notizbuch sichern', 'backup', () => this.run(async()=>{await this.requireSaved();await backupNotebook(this.notebook.id);}), {disabled:disabled||!this.persistent}),
            action('restore-backup', 'Sicherung als neues Notizbuch öffnen', 'restore', () => element<HTMLInputElement>('backup-file').click(), {disabled:disabled||!this.persistent}),
            action('manage', 'Notizbücher und Themen verwalten', 'settings', () => this.manage()),
            action('pen-presets', 'Farben und Strichdicken konfigurieren', 'pen', () => this.penOptions()),
            action('customize', 'Schreibleiste anpassen', 'settings', () => this.toolbar.openCustomizer()),
            action('placement', this.toolbar.preferences.floating ? 'Leiste oben andocken' : 'Leiste frei platzieren', this.toolbar.preferences.floating ? 'pin' : 'move', () => this.toolbar.toggleDock()),
            action('diagnostics', 'Stifteingabe prüfen', 'diagnostic', () => { this.input.finish(); this.diagnostics.refresh(); element<HTMLDialogElement>('diagnostics-dialog').showModal(); this.paintObservation(); }),
        ];
        // The panel keeps lecture actions; rarely used administration opens a dialog.
        this.renderTools([
            action('import', 'PDF als Thema einfügen', 'pdf', () => element<HTMLInputElement>('pdf-file').click(), { disabled: disabled || !this.persistent }),
            action('blank', 'Leeres Thema', 'blank', () => this.askTitle('Leeres Thema', 'Neues Thema', name => this.run(async () => { if (!await this.queue.flush())
                throw new Error('Bitte zuerst speichern.'); const id = await createTopic(this.notebook.id, name, []); this.loaded = await loadNotebook(this.notebook.id); this.display(this.notebook.topics.find(topic => topic.id === id)!.pages[0]!); this.publisher?.refresh(); })), { disabled: disabled || !this.persistent }),
            action('zoom', `Zoom und Ansicht · ${this.zoom.label}`, 'zoom', () => { this.input.finish(); this.zoomOptions(); }),
            action('zoom-lock', this.zoom.locked ? 'Zoom entsperren' : 'Zoom fixieren', this.zoom.locked ? 'lock' : 'unlock', () => this.zoom.setLocked(!this.zoom.locked), {pressed: this.zoom.locked}),
            action('share', 'Notizbuch teilen', 'link', () => this.openSharing(), { pressed: this.sharing, disabled: disabled || !this.persistent }),
            action('qr', 'QR-Code für Studierende zeigen', 'qr', () => this.showQr(), { disabled: !this.sharingState.viewerUrl }),
            action('fullscreen', 'Vollbild', 'fullscreen', () => {void toggleFullscreen().catch(report);}, { disabled: !this.persistent }),
            action('export', 'Aktuelles Thema als PDF exportieren', 'download', () => this.exportDialog(), {disabled:disabled||!this.persistent}),
            action('settings', 'Verwaltung und Einstellungen', 'settings', () => this.settingsDialog(settings)),
        ]);
    }
    private blankPageAction(action: (id: string, label: string, name: string, run: () => void, extra?: Partial<ToolbarAction>) => ToolbarAction): ToolbarAction {
        return action('blank-page', 'Leere Seite danach einfügen', 'plus', () => this.run(async () => { if (!await this.queue.flush())
            throw new Error('Bitte zuerst speichern.'); const id = await insertBlankPage(this.current.id); this.loaded = await loadNotebook(this.notebook.id); this.display(findPage(this.notebook, id)); this.publisher?.refresh(); }), { disabled: !this.ready || this.busy || this.closing || !this.persistent });
    }
    private settingsDialog(actions: ToolbarAction[]): void {
        const dialog = this.dialog('Verwaltung und Einstellungen'), list = document.createElement('div');
        list.className = 'settings-actions';
        for (const action of actions) {
            const node = button(action.label, action.icon, () => { dialog.close(); action.run(); }, action.description);
            node.dataset.action = action.id;
            node.disabled = action.disabled ?? false;
            node.append(document.createTextNode(action.label));
            list.append(node);
        }
        dialog.append(list);
        dialog.showModal();
    }
    private async copyViewerLink(): Promise<void> {
        const field = element<HTMLInputElement>('share-link');
        try { await navigator.clipboard.writeText(field.value); element('share-copy-status').textContent = 'Link kopiert.'; }
        catch { field.select(); element('share-copy-status').textContent = 'Link markiert – mit ⌘C kopieren.'; }
    }
    /** Large QR code for the projector; rendered on a canvas, no network access. */
    private showQr(): void {
        const url = this.sharingState.viewerUrl;
        if (!url) return;
        this.input.finish();
        element<HTMLDialogElement>('sharing-dialog').close();
        const dialog = element<HTMLDialogElement>('qr-dialog'), canvas = element<HTMLCanvasElement>('qr-code');
        const qr = encodeQr(url, {ecc: 'M', border: 2}), size = Math.floor(Math.min(window.innerWidth, window.innerHeight) * .72);
        const module = Math.max(2, Math.floor(size * (window.devicePixelRatio || 1) / qr.size));
        canvas.width = canvas.height = module * qr.size;
        canvas.style.width = canvas.style.height = `${size}px`;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#000';
        qr.data.forEach((row, y) => row.forEach((dark, x) => { if (dark) context.fillRect(x * module, y * module, module, module); }));
        element('qr-url').textContent = url;
        dialog.showModal();
    }
    private togglePanel(id: 'drawer' | 'tools-panel'): void {
        this.input.finish();
        const open = element(id).hidden;
        if (open && id === 'drawer') this.drawer();
        element(id).hidden = !open;
        this.updateToolbar();
    }
    private renderTools(actions: ToolbarAction[]): void {
        const panel = element('tools-panel');
        panel.replaceChildren();
        const labels: Record<string, string> = {share: 'Teilen', qr: 'QR-Code', fullscreen: 'Vollbild', export: 'PDF exportieren',
            zoom: 'Ansicht', 'zoom-lock': this.zoom.locked ? 'Zoom entsperren' : 'Zoom fixieren', settings: 'Einstellungen …'};
        for (const action of actions) {
            const node = button(action.label, action.icon, () => {
                this.input.finish(); panel.hidden = true; action.run(); this.updateToolbar();
            }, action.description);
            node.dataset.action = action.id;
            node.disabled = action.disabled ?? false;
            if (action.pressed !== undefined) node.setAttribute('aria-pressed', String(action.pressed));
            if (labels[action.id]) node.append(document.createTextNode(labels[action.id]!));
            panel.append(node);
        }
        panel.append(button('Werkzeugleiste schließen', 'close', () => this.togglePanel('tools-panel')));
        this.positionPanels();
    }
    private positionPanels(): void {
        document.body.style.setProperty('--writing-bar-height', `${element('toolbar').offsetHeight}px`);
        const panel = element('tools-panel');
        document.body.style.setProperty('--tools-panel-height', `${panel.hidden ? 0 : panel.offsetHeight}px`);
        // Only move a floating bar that would cover the compact panel. Closing
        // the panel restores its saved position; the paper never moves.
        this.toolbar.setFloatingTopInset(panel.hidden ? 0 : panel.offsetHeight);
    }
    private chooseMarker(color: string, width: number): void {
        this.input.finish(); this.clearSelection(); this.pen.markerColor = color; this.pen.markerWidth = width; this.tool = 'highlighter';
        this.preference('pen-presets', JSON.stringify(this.pen)); this.status();
    }
    private choosePen(color: string, width: number): void {
        this.input.finish(); this.clearSelection(); this.pen.color = color; this.pen.width = width; this.tool = 'pen';
        this.preference('pen-presets', JSON.stringify(this.pen)); this.status();
    }
    private savePenPresets(value: PenPreferences): void {
        this.input.finish();
        const next = penPreferences(value), nextIds = writingActionIds(next);
        const pinned = updatedWritingPins(this.toolbar.preferences.pinned, this.writingIds, nextIds);
        this.pen = next;
        this.writingIds.splice(0, this.writingIds.length, ...nextIds);
        this.toolbar.configure({...this.toolbar.preferences, pinned});
        this.preference('pen-presets', JSON.stringify(this.pen));
        this.preference('toolbar-writing', JSON.stringify(this.toolbar.preferences));
        this.tool = 'pen'; this.status();
    }
    private drawer(): void {
        const drawer = element('drawer');
        drawer.replaceChildren();
        const header = document.createElement('header');
        header.textContent = 'Notizbücher';
        header.append(button('Drawer schließen', 'close', () => this.togglePanel('drawer'), 'Die linke Notizbuch- und Themenleiste schließen.'));
        drawer.append(header);
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Notizbuch auswählen');
        select.title = 'Zu einem anderen lokal gespeicherten Notizbuch wechseln.';
        for (const book of this.library.notebooks) {
            const option = document.createElement('option');
            option.value = book.id;
            option.textContent = book.title;
            option.selected = book.id === this.notebook.id;
            select.append(option);
        }
        select.disabled = this.busy;
        select.addEventListener('change', () => this.run(() => this.selectNotebook(select.value)));
        select.addEventListener('contextmenu', event => this.notebookMenu(event, this.notebook.id));
        header.addEventListener('contextmenu', event => this.notebookMenu(event, this.notebook.id));
        drawer.append(select);
        const create = button('Neues Notizbuch', 'plus', () => this.askTitle('Notizbuch erstellen', 'Neue Veranstaltung', name => this.run(async () => { if (!await this.queue.flush())
            throw new Error('Bitte zuerst speichern.'); const id = await createNotebook(name); this.library = await loadLibrary(); await this.selectNotebook(id); })));
        create.disabled = !this.persistent || this.busy;
        const manage=button('Notizbücher und Themen verwalten','settings',()=>this.manage());manage.disabled=!this.persistent||this.busy;
        const operations=document.createElement('div');operations.className='drawer-operations';operations.append(create,manage);
        drawer.append(operations);
        const label = document.createElement('div');
        label.className = 'drawer-title';
        label.textContent = 'Themen';
        drawer.append(label);
        // Topics can be dragged into a new order; a drag never also opens the topic.
        let drag: {id: string; pointer: number; y: number; moving: boolean; target: number} | null = null, suppressClick = false;
        const nodes: HTMLButtonElement[] = [];
        const markers = (): void => { for (const item of nodes) item.classList.remove('drop-before', 'drop-after', 'dragging'); };
        for (const topic of this.notebook.topics) {
            const node = document.createElement('button');
            nodes.push(node);
            node.type = 'button';
            node.className = 'topic-button';
            node.title = `Thema „${topic.title}“ öffnen: ${topic.pages.length} Seiten. Startet auf der ersten Seite. Ziehen ändert die Reihenfolge, Rechtsklick zeigt weitere Aktionen.`;
            node.addEventListener('contextmenu', event => this.topicMenu(event, topic.id));
            node.addEventListener('pointerdown', event => { if (event.button === 0 && !this.busy) drag = {id: topic.id, pointer: event.pointerId, y: event.clientY, moving: false, target: -1}; });
            node.addEventListener('pointermove', event => {
                if (!drag || drag.id !== topic.id || event.pointerId !== drag.pointer) return;
                if (!drag.moving && Math.abs(event.clientY - drag.y) < 6) return;
                if (!drag.moving) { drag.moving = true; node.setPointerCapture(event.pointerId); }
                // Insertion index: before the first topic whose vertical middle is below the pointer.
                const index = nodes.findIndex(item => { const rect = item.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2; });
                drag.target = index < 0 ? nodes.length : index;
                markers(); node.classList.add('dragging');
                if (drag.target < nodes.length) nodes[drag.target]!.classList.add('drop-before'); else nodes.at(-1)!.classList.add('drop-after');
            });
            const finish = (): void => {
                const state = drag; drag = null; markers();
                if (!state?.moving) return;
                suppressClick = true;
                const ids = this.notebook.topics.map(item => item.id), from = ids.indexOf(state.id);
                ids.splice(from, 1); ids.splice(state.target > from ? state.target - 1 : state.target, 0, state.id);
                if (ids.join() !== this.notebook.topics.map(item => item.id).join())
                    this.run(async () => { await this.requireSaved(); await reorderItems(this.notebook.id, ids); await this.reloadMetadata(); });
            };
            node.addEventListener('pointerup', finish);
            node.addEventListener('pointercancel', () => { drag = null; markers(); });
            node.innerHTML = icon(topic.pages.some(page => page.background) ? 'pdf' : 'blank') + `<span>${escapeHtml(topic.title)}</span><small>${topic.pages.length}</small>`;
            if (topic.pages.some(page => page.id === this.current.id))
                node.setAttribute('aria-current', 'page');
            node.disabled = this.busy;
            node.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } drawer.hidden = true; this.run(() => this.selectPage(topic.pages[0]!.id)); });
            drawer.append(node);
        }
    }
    // ---- Context menus and deletion ----------------------------------------
    /** A small menu at the pointer; closes on outside click, Escape, scroll or blur. */
    private contextMenu(event: MouseEvent, items: {label: string; icon: string; run: () => void; disabled?: boolean; danger?: boolean}[]): void {
        event.preventDefault();
        if (!this.persistent || this.busy) return;
        this.input.finish();
        document.querySelector('.context-menu')?.remove();
        const menu = document.createElement('div');
        menu.className = 'toolbar-menu context-menu';
        menu.setAttribute('role', 'menu');
        const close = (): void => { menu.remove(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', close); };
        const outside = (pointer: PointerEvent): void => { if (!menu.contains(pointer.target as Node)) close(); };
        const escape = (key: KeyboardEvent): void => { if (key.key === 'Escape') { key.stopPropagation(); close(); } };
        for (const item of items) {
            const node = button(item.label, item.icon, () => { close(); item.run(); });
            node.append(document.createTextNode(item.label));
            node.setAttribute('role', 'menuitem');
            node.disabled = item.disabled ?? false;
            if (item.danger) node.classList.add('danger');
            menu.append(node);
        }
        document.body.append(menu);
        menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8))}px`;
        document.addEventListener('pointerdown', outside, true);
        window.addEventListener('keydown', escape, true);
        window.addEventListener('blur', close);
        menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
    private topicMenu(event: MouseEvent, id: string): void {
        const topic = this.notebook.topics.find(item => item.id === id);
        if (!topic) return;
        this.contextMenu(event, [
            {label: 'Öffnen', icon: 'pdf', run: () => { element('drawer').hidden = true; this.run(() => this.selectPage(topic.pages[0]!.id)); }},
            {label: 'Umbenennen …', icon: 'pen', run: () => this.askTitle('Thema umbenennen', topic.title, name => this.run(async () => { await this.requireSaved(); await renameItem(this.notebook.id, topic.id, name); await this.reloadMetadata(); }), 'Speichern')},
            {label: 'Löschen …', icon: 'trash', danger: true, disabled: this.notebook.topics.length <= 1, run: () => this.deleteTopicFlow(topic.id)},
        ]);
    }
    private notebookMenu(event: MouseEvent, id: string): void {
        const book = this.library.notebooks.find(item => item.id === id);
        if (!book) return;
        this.contextMenu(event, [
            {label: 'Umbenennen …', icon: 'pen', run: () => this.askTitle('Notizbuch umbenennen', book.title, name => this.run(async () => { await this.requireSaved(); await renameItem(book.id, book.id, name); await this.reloadMetadata(); }), 'Speichern')},
            {label: 'Neues Notizbuch …', icon: 'plus', run: () => this.askTitle('Notizbuch erstellen', 'Neue Veranstaltung', name => this.run(async () => { await this.requireSaved(); const created = await createNotebook(name); this.library = await loadLibrary(); await this.selectNotebook(created); }))},
            {label: 'Verwalten …', icon: 'settings', run: () => this.manage()},
            {label: 'Löschen …', icon: 'trash', danger: true, disabled: this.library.notebooks.length <= 1, run: () => this.deleteNotebookFlow(book.id)},
        ]);
    }
    /** Built-in confirmation (separate dialog, so an open management dialog stays). */
    private confirmDelete(title: string, text: string, option?: {label: string; checked: boolean}, confirmLabel = 'Endgültig löschen'): Promise<{option: boolean} | null> {
        this.input.finish();
        return new Promise(resolve => {
            const dialog = document.createElement('dialog'), header = document.createElement('header'), heading = document.createElement('h2'), message = document.createElement('p');
            heading.textContent = title; message.textContent = text;
            let result: {option: boolean} | null = null;
            header.append(heading, button('Abbrechen', 'close', () => dialog.close()));
            dialog.append(header, message);
            const checkbox = document.createElement('input');
            if (option) {
                const label = document.createElement('label'); label.className = 'input-rate-option';
                checkbox.type = 'checkbox'; checkbox.checked = option.checked;
                label.append(checkbox, document.createTextNode(option.label)); dialog.append(label);
            }
            const actions = document.createElement('div'); actions.className = 'dialog-actions';
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Abbrechen'; cancel.addEventListener('click', () => dialog.close());
            const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'primary danger'; confirm.textContent = confirmLabel;
            confirm.addEventListener('click', () => { result = {option: option ? checkbox.checked : false}; dialog.close(); });
            actions.append(cancel, confirm); dialog.append(actions);
            dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, {once: true});
            document.body.append(dialog); dialog.showModal(); cancel.focus();
        });
    }
    private deleteTopicFlow(id: string, after?: () => void): void {
        const topic = this.notebook.topics.find(item => item.id === id);
        if (!topic || this.notebook.topics.length <= 1) { report('Ein Notizbuch braucht mindestens ein Thema.'); return; }
        const shared = this.enabledBooks.has(this.notebook.id);
        void this.confirmDelete(`Thema „${topic.title}“ löschen?`,
            `Alle ${topic.pages.length} Seiten dieses Themas mit ihrer Handschrift werden gelöscht. Das lässt sich nicht rückgängig machen.` +
            (shared ? ' Auf dem Server verschwindet das Thema beim nächsten Abgleich ebenfalls.' : '')).then(answer => {
            if (!answer) return;
            this.run(async () => {
                await this.requireSaved();
                const index = this.notebook.topics.findIndex(item => item.id === id), wasCurrent = topic.pages.some(page => page.id === this.current.id);
                await deleteTopic(this.notebook.id, id);
                this.library = await loadLibrary(); this.loaded = await loadNotebook(this.notebook.id);
                const target = wasCurrent ? this.notebook.topics[Math.min(index, this.notebook.topics.length - 1)]!.pages[0]! : findPage(this.notebook, this.current.id);
                this.display(target); this.publisher?.refresh();
                after?.();
            });
        });
    }
    private deleteNotebookFlow(id: string, after?: () => void): void {
        const book = this.library.notebooks.find(item => item.id === id);
        if (!book || this.library.notebooks.length <= 1) { report('Das letzte Notizbuch kann nicht gelöscht werden.'); return; }
        const server = (this.library.syncTargets ?? []).find(target => target.notebookId === id)?.server ?? this.sharingServers.get(id);
        void this.confirmDelete(`Notizbuch „${book.title}“ löschen?`,
            'Alle Themen, Seiten und Handschrift dieses Notizbuchs werden auf diesem Mac gelöscht. Das lässt sich nicht rückgängig machen; eine vorherige Sicherung ist möglich unter Einstellungen → Notizbuch sichern.',
            server ? {label: `Auch vom Server ${new URL(server).host} entfernen – die Leselinks der Studierenden funktionieren dann nicht mehr.`, checked: true} : undefined).then(answer => {
            if (!answer) return;
            this.run(async () => {
                const wasCurrent = id === this.notebook.id;
                if (wasCurrent) await this.requireSaved();
                if (server && answer.option) {
                    // Withdraw first: afterwards the private secret is gone locally.
                    const key = this.serverKeys.get(publisherServer(server).origin) ?? await loadPublisherKey(server, true);
                    if (key) this.storedKeys.set(publisherServer(server).origin, key);
                    if (!key) throw new Error('Zum Entfernen vom Server wird der Zugangsschlüssel benötigt. Bitte unter „Teilen“ eintragen oder die Option abwählen.');
                    await withdrawFromServer(server, key, wasCurrent ? this.loaded.secret : (await loadNotebook(id)).secret);
                }
                this.publishers.get(id)?.stop(); this.publishers.delete(id);
                this.enabledBooks.delete(id); this.sharingServers.delete(id); this.sharingStates.delete(id);
                await deleteNotebook(id);
                // Drop it from the list at once; the reload below refreshes everything else.
                this.library.notebooks = this.library.notebooks.filter(item => item.id !== id);
                this.library = await loadLibrary();
                if (wasCurrent) { this.loaded = await loadNotebook(this.library.notebooks[0]!.id); this.attachPublisher(); this.display(notebookPages(this.notebook)[0]!); }
                else this.drawer();
                after?.();
            });
        });
    }
    private dialog(title: string): HTMLDialogElement { this.input.finish(); const dialog = element<HTMLDialogElement>('editor-dialog'); dialog.replaceChildren(); const header = document.createElement('header'), heading = document.createElement('h2'); heading.textContent = title; header.append(heading, button('Schließen', 'close', () => dialog.close())); dialog.append(header); return dialog; }
    private askTitle(title: string, initial: string, accept: (title: string) => void, confirmation = 'Erstellen'): void {
        const dialog = this.dialog(title), form = document.createElement('form'), label = document.createElement('label');
        label.textContent = 'Titel';
        const input = document.createElement('input');
        input.value = initial;
        input.title = 'Titel für das Notizbuch oder Thema eingeben.';
        input.required = true;
        input.maxLength = 200;
        label.append(input);
        form.append(label);
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.className = 'primary';
        submit.textContent = confirmation;
        submit.title = `${confirmation}: den eingegebenen Titel übernehmen.`;
        form.append(submit);
        form.addEventListener('submit', event => { event.preventDefault(); const name = input.value.trim(); if (!name)
            return; dialog.close(); accept(name); });
        dialog.append(form);
        dialog.showModal();
        input.select();
    }
    private penOptions(): void {
        const dialog = this.dialog('Farben und Strichdicken');
        penPresetsForm(dialog, this.pen, next => this.savePenPresets(next));
        dialog.showModal();
    }
    private zoomOptions(): void {
        const dialog = this.dialog('Ansicht'), controls = zoomControls(this.zoom);
        controls.querySelector('select')!.id = 'zoom';
        dialog.append(controls); dialog.showModal();
    }
    private pagePicker(pages: NotePage[], index: number): void {
        const dialog = this.dialog('Seiten'), label = document.createElement('label');
        label.textContent = `Seite (1–${pages.length})`;
        const jump = document.createElement('input');
        jump.type = 'number';
        jump.min = '1';
        jump.max = String(pages.length);
        jump.value = String(index + 1);
        jump.title = 'Gewünschte Seitennummer eingeben und mit Enter öffnen.';
        label.append(jump);
        dialog.append(label);
        const go = () => { const number = Number(jump.value); if (Number.isInteger(number) && number >= 1 && number <= pages.length) {
            dialog.close();
            this.run(() => this.selectPage(pages[number - 1]!.id));
        } };
        jump.addEventListener('keydown', event => { if (event.key === 'Enter')
            go(); });
        const previews = new PageThumbnails(dialog, readPdfAsset);
        dialog.addEventListener('close', () => previews.dispose(), { once: true });
        const grid = document.createElement('div');
        grid.className = 'thumbnails';
        for (const [i, page] of pages.entries()) {
            const node = document.createElement('button');
            node.type = 'button';
            node.className = 'thumbnail';
            if (i === index)
                node.setAttribute('aria-current', 'page');
            node.setAttribute('aria-label', `Seite ${i + 1}`);
            node.title = `Seite ${i + 1} öffnen.`;
            const preview = document.createElement('canvas');
            previews.add(preview, page);
            node.append(preview, document.createTextNode(String(i + 1)));
            node.addEventListener('click', () => { dialog.close(); this.run(() => this.selectPage(page.id)); });
            grid.append(node);
        }
        dialog.append(grid);
        dialog.showModal();
    }
    private openSharing(): void {
        this.input.finish();
        element('sharing-notebook').textContent = `${this.notebook.title} · Alle Themen`;
        element<HTMLDialogElement>('sharing-dialog').showModal();
        void this.fillPublisherKey();
    }
    private async fillPublisherKey(interactive=false): Promise<void> {
        const server=element<HTMLInputElement>('share-server').value, field=element<HTMLInputElement>('share-key');
        field.value='';
        try {
            const origin=publisherServer(server).origin, known=this.serverKeys.get(origin);
            // A key already known in this session needs no further Keychain access.
            const key=known ?? await loadPublisherKey(server,interactive);
            if (!known && key) {this.storedKeys.set(origin,key); this.serverKeys.set(origin,key);}
            // Only an explicit (interactive) lookup proves that nothing is stored.
            if (!known && !key && interactive) this.storedKeys.set(origin,null);
            if (element<HTMLInputElement>('share-server').value===server && !field.value) field.value=key ?? '';
        } catch(error) {report(error);}
    }
    private updateSharing(): void {
        const labels = { off: 'Nur lokal', connecting: 'Verbinde …', live: 'Live · Serverstand bestätigt', reconnecting: 'Verbindung unterbrochen · Verbinde erneut …', error: 'Synchronisation nicht verfügbar' };
        element('share-status').textContent = this.sharingState.detail ?? labels[this.sharingState.phase];
        element('share-status').dataset.state = this.sharingState.phase;
        const link = element<HTMLAnchorElement>('viewer-link'), url = this.sharingState.viewerUrl;
        link.hidden = !url;
        element('share-link-row').hidden = !url;
        if (url) {
            link.href = url;
            if (element<HTMLInputElement>('share-link').value !== url) { element<HTMLInputElement>('share-link').value = url; element('share-copy-status').textContent = ''; }
        }
        element<HTMLButtonElement>('share-toggle').textContent = this.sharing ? 'Synchronisation anhalten' : 'Synchronisieren und live teilen';
        element('share-toggle').title = this.sharing ? 'Weitere Übertragung anhalten. Der bereits bestätigte Serverstand bleibt über den Leselink erreichbar.' : 'Dieses Notizbuch mit dem eingestellten Server synchronisieren und den Browserlink bereitstellen.';
        element<HTMLInputElement>('share-server').disabled = this.sharing;
        element<HTMLInputElement>('share-key').disabled = this.sharing;
        element<HTMLInputElement>('share-remember').disabled = this.sharing;
        element<HTMLButtonElement>('share-load-key').disabled = this.sharing;
    }
    private observe(observation: InputObservation): void {
        this.metrics.observe(observation);
        this.latestInput = observation;
        if (observation.pointerType === 'pen' && observation.inContact) {
            this.minimum = Math.min(this.minimum, observation.pressure);
            this.maximum = Math.max(this.maximum, observation.pressure);
        }
        if (!element<HTMLDialogElement>('diagnostics-dialog').open || this.diagnosticsFrame !== null)
            return;
        this.diagnosticsFrame = requestAnimationFrame(() => { this.diagnosticsFrame = null; this.paintObservation(); });
    }
    private paintObservation(): void {
        const sample = this.latestInput;
        if (!sample) return;
        element('device').textContent = `${sample.pointerType === 'pen' ? 'Stift' : sample.pointerType === 'mouse' ? 'Maus' : sample.pointerType} (${sample.source === 'appkit' ? 'AppKit' : 'Pointer Events'})`;
        element<HTMLMeterElement>('pressure-meter').value = sample.pressure;
        element('pressure').textContent = sample.pressure.toFixed(3);
        element('pressure-range').textContent = Number.isFinite(this.minimum) ? `${this.minimum.toFixed(3)} – ${this.maximum.toFixed(3)}` : '—';
        element('event').textContent = sample.phase; element('buttons').textContent = `${sample.button} / ${sample.buttons}`;
        element('samples').textContent = String(sample.sampleCount);
        element('input-note').textContent = sample.pointerType === 'pen' ? 'Druckvariation und Schreibgefühl manuell prüfen.' : 'Mauseingabe verwendet den festen Ersatzdruck 0,5.';
    }
    private async prepareClose(): Promise<void> {
        if (this.closing)
            return;
        this.closing = true;
        this.diagnostics.cancel();
        this.input.finish();
        this.status();
        try {
            if (this.structureTask)
                await this.structureTask;
            if (!await this.queue.flush() || !await this.flushPreferences()) {
                this.closing = false;
                element('discard-close').hidden = false;
                this.status();
                return;
            }
            await closeApp();
        }
        catch (error) {
            this.closing = false;
            report(error);
            this.status();
        }
    }
}
window.addEventListener('error', event => report(event.message));
window.addEventListener('unhandledrejection', event => report(event.reason));
try {
    new Editor();
}
catch (error) {
    report(error);
}
