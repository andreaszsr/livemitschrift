import { notebookPages, parseNotebookMessage, SyncTransfer, validNotebookSnapshot, validSyncPage } from '@livemitschrift/core';
import type { NotebookEvent, NotebookSnapshot, NotePage } from '@livemitschrift/core';
import type { ViewerState } from './viewer-state.js';

/** Client-side subscription budget, below the server's reader limit (10/s, burst 40). */
const SUBSCRIBE_BURST = 6;
const SUBSCRIBE_RATE = 4;
/** Codes after which reconnecting cannot help: unknown notebook or oversized data. */
const PERMANENT_CLOSE = [1008, 1009];
/** Local validation failures (not sent by the server) retry a few times first. */
const LOCAL_ERROR = 4000;
const MAX_LOCAL_ERRORS = 3;

/** Exponential backoff with jitter so many readers do not reconnect in lockstep. */
export function retryDelay(attempt: number, code: number, random = Math.random): number {
    const base = Math.min(500 * 2 ** attempt, 5000);
    // 1013 means "try again later" (server busy/rate limited): wait at least 2 s.
    return Math.max(code === 1013 ? 2000 : 0, base / 2 + random() * base / 2);
}

/** The cache is checked against the server before reuse, including after reconnect. */
export class PagedConnection {
    private socket: WebSocket | null = null;
    private stopped = true;
    private retries = 0;
    private retryTimer: number | undefined;
    private heartbeatTimer: number | undefined;
    private lastReply = 0;
    private connected = false;
    private structured = false;
    private request = 0;
    private selected: string | null = null;
    private readonly cache = new Map<string, {page: NotePage; revision: string}>();
    private subscribed = false;
    private tokens = SUBSCRIBE_BURST;
    private refilled = Date.now();
    private subscribeTimer: number | undefined;
    private localErrors = 0;
    private reported: ViewerState | null = null;
    /** Report only changes; messages arrive per ink batch and must not rebuild the UI. */
    private state(next: ViewerState): void {
        if (next !== this.reported) {this.reported = next; this.notify(next);}
    }
    constructor(private readonly url: URL,
        private readonly message: (message: NotebookSnapshot | NotebookEvent) => void,
        private readonly page: (page: NotePage) => void,
        private readonly notify: (state: ViewerState) => void,
        private readonly loading: (loading: boolean) => void) {}
    start(): void {this.stop(); this.stopped = false; this.retries = 0; this.connect();}
    stop(): void {
        this.stopped = true; window.clearTimeout(this.retryTimer); window.clearTimeout(this.heartbeatTimer); window.clearTimeout(this.subscribeTimer); this.subscribeTimer = undefined;
        const socket = this.socket; this.socket = null; socket?.close();
    }
    /** Reconnect promptly when a tab/phone becomes active again or the network returns. */
    wake(): void {
        if (this.stopped || (this.socket && Date.now() - this.lastReply < 15000)) return;
        window.clearTimeout(this.retryTimer); this.retries = 0;
        const socket = this.socket; this.socket = null; socket?.close();
        this.connect();
    }
    select(pageId: string): void {
        if (this.selected === pageId && this.subscribed) return;
        this.selected = pageId; this.subscribed = false; this.request++;
        this.loading(true);
        this.subscribe();
    }
    /**
     * Rapid page changes (fast Follow, quick tapping) are coalesced: within the
     * token budget a subscribe goes out at once, otherwise only the latest
     * selection is sent when the next token is available.
     */
    private subscribe(waited = false): void {
        if (this.subscribeTimer !== undefined || this.subscribed || !this.selected) return;
        if (this.socket?.readyState !== WebSocket.OPEN || !this.structured) return;
        const now = Date.now();
        // After waiting for the computed refill time, the next token is due.
        this.tokens = Math.max(waited ? 1 : 0, Math.min(SUBSCRIBE_BURST, this.tokens + (now - this.refilled) / 1000 * SUBSCRIBE_RATE));
        this.refilled = now;
        if (this.tokens < 1) {
            this.subscribeTimer = window.setTimeout(() => {this.subscribeTimer = undefined; this.subscribe(true);}, (1 - this.tokens) / SUBSCRIBE_RATE * 1000);
            return;
        }
        this.tokens--;
        this.socket.send(JSON.stringify({type: 'subscribe', pageId: this.selected, revision: this.cache.get(this.selected)?.revision, request: this.request}));
        this.subscribed = true;
    }
    private remember(page: NotePage, revision: string): void {
        this.cache.delete(page.id); this.cache.set(page.id, {page, revision});
        let points = [...this.cache.values()].reduce((sum, {page}) => sum + page.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0), 0);
        while (this.cache.size > 1 && (this.cache.size > 4 || points > 500_000)) {
            const oldest = this.cache.keys().next().value!;
            points -= this.cache.get(oldest)!.page.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
            this.cache.get(oldest)!.page.strokes = [];
            this.cache.delete(oldest);
        }
    }
    private connect(): void {
        if (this.stopped) return;
        this.state('connecting'); this.structured = false; this.subscribed = false;
        const transfers = new SyncTransfer();
        let socket: WebSocket;
        try {socket = new WebSocket(this.url);} catch {this.disconnect(1006); return;}
        this.socket = socket;
        socket.onopen = () => {if (this.socket === socket) {this.lastReply = Date.now(); this.heartbeat();}};
        socket.onmessage = event => {
            if (this.socket !== socket) return;
            try {
                const value = transfers.receive(event.data);
                this.lastReply = Date.now(); this.retries = 0;
                if (!value) return;
                if (value.type === 'pong') return;
                if (value.type === 'source_status' && typeof value.connected === 'boolean') this.connected = value.connected;
                else if (value.type === 'structure') {
                    const snapshot = {...value, type: 'notebook'};
                    if (!validNotebookSnapshot(snapshot) || notebookPages(snapshot.notebook).some(page => page.strokes.length)) throw new Error('Invalid notebook structure.');
                    for (const page of notebookPages(snapshot.notebook)) {
                        const cached = this.cache.get(page.id);
                        if (cached) cached.page = {...page, strokes: cached.page.strokes};
                    }
                    this.structured = true; this.subscribed = false;
                    this.message(snapshot);
                } else if (value.type === 'page' || value.type === 'page_current') {
                    if (value.request !== this.request) return;
                    if (typeof value.revision !== 'string' || value.revision.length > 200) throw new Error('Invalid page revision.');
                    let page: NotePage;
                    if (value.type === 'page') {
                        if (!validSyncPage(value.page) || value.page.id !== this.selected) throw new Error('Invalid page.');
                        page = value.page;
                    } else {
                        const cached = this.cache.get(String(value.pageId));
                        if (!cached || value.pageId !== this.selected || cached.revision !== value.revision) throw new Error('Invalid cache confirmation.');
                        page = cached.page;
                    }
                    this.remember(page, value.revision); this.page(page); this.loading(false); this.localErrors = 0;
                } else if (value.type === 'revision') {
                    const cached = this.cache.get(String(value.pageId));
                    if (cached && value.pageId === this.selected && typeof value.revision === 'string') cached.revision = value.revision;
                } else {
                    const parsed = parseNotebookMessage(JSON.stringify(value));
                    if (['notebook', 'source_status', 'pong'].includes(parsed.type)) throw new Error('Unexpected message.');
                    const message = parsed as NotebookEvent;
                    const pageId = message.type === 'viewport' || message.type === 'extent' ? null : message.type === 'edit' ? message.edit.pageId : message.pageId;
                    if (pageId === null || pageId === this.selected) this.message(message);
                }
                this.state(this.connected && this.structured ? 'live' : 'waiting');
            } catch (error) {console.error('Page viewer:', error); this.disconnect(LOCAL_ERROR);}
        };
        socket.onerror = () => {if (this.socket === socket) this.disconnect(1006);};
        socket.onclose = event => {if (this.socket === socket) this.disconnect(event.code);};
    }
    private heartbeat(): void {
        this.heartbeatTimer = window.setTimeout(() => {
            if (Date.now() - this.lastReply > 45000) {this.disconnect(1006); return;}
            try {this.socket?.send(JSON.stringify({type: 'ping'}));} catch {this.disconnect(1006); return;}
            if (this.socket) this.heartbeat();
        }, 5000);
    }
    private disconnect(code: number): void {
        window.clearTimeout(this.heartbeatTimer); window.clearTimeout(this.subscribeTimer); this.subscribeTimer = undefined; this.subscribed = false;
        const socket = this.socket; this.socket = null; socket?.close();
        if (this.stopped) return;
        if (code === LOCAL_ERROR) this.localErrors++;
        if (PERMANENT_CLOSE.includes(code) || this.localErrors >= MAX_LOCAL_ERRORS) {this.state('error'); this.loading(false); return;}
        this.state('disconnected');
        window.clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => this.connect(), retryDelay(this.retries++, code));
    }
}
