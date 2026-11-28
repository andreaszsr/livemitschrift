import { MAX_BATCH_POINTS, MAX_SYNC_PAGE_BYTES, notebookPages, notebookStructure, syncFrames } from '@livemitschrift/core';
import type { Notebook, NotebookEvent, NotebookSnapshot, PageEdit, Point } from '@livemitschrift/core';
import { accessError, publisherKey, publisherServer } from './publisher-access.js';
import type { SharingState } from './sharing-state.js';

class SyncProtocolError extends Error {}

interface Revision {sequence: number; head: string}
export interface DeltaSync {
    status(): Promise<Revision & {firstPending: number | null}>;
    checkpoint(): Promise<Revision & {notebook: Notebook}>;
    outgoing(after: number): Promise<(Revision & {change: unknown})[]>;
    acknowledge(sequence: number): Promise<void>;
    preview?(): NotebookSnapshot | null;
}

/** Local commits remain authoritative. Network work never gates local drawing. */
export class DeltaPublisher {
    private socket: WebSocket | null = null;
    private base: URL | null = null;
    private key = '';
    private enabled = false;
    private ready = false;
    private acceptingInk = false;
    private forceRecovery = false;
    private needsPreview = false;
    private structureVersion = 0;
    private generation = 0;
    private sequence = 0;
    private viewerUrl: string | null = null;
    private retries = 0;
    private retryTimer: number | undefined;
    private pollTimer: number | undefined;
    private heartbeatTimer: number | undefined;
    private pointsTimer: number | undefined;
    private lastReply = 0;
    private controller: AbortController | null = null;
    private waiters = new Map<string, {resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: number}>();
    private sending: Promise<void> = Promise.resolve();
    private pumping = false;
    private pending: {pageId: string; strokeId: string; points: Point[]} | null = null;
    private assets = new Set<string>();
    constructor(private readonly snapshot: () => NotebookSnapshot, private readonly secret: string,
        private readonly readPdf: (id: string) => Promise<Uint8Array>, private readonly readImage: (id: string) => Promise<Uint8Array>,
        private readonly state: (state: SharingState) => void,
        private readonly durable: DeltaSync) {}

    start(server: string, key: string): void {
        const base = publisherServer(server); publisherKey(key); this.stop();
        this.base = base; this.key = key; this.enabled = true; this.retries = 0;
        void this.connect();
    }
    stop(): void {this.enabled = false; this.reset(); this.state({phase: 'off', viewerUrl: null});}
    refresh(): void {
        this.structureVersion++; this.acceptingInk = false; this.needsPreview = true; this.flushPoints(); this.changed();
    }
    changed(): void {if (this.ready) void this.pump();}

    publish(event: NotebookEvent): void {
        if (!this.acceptingInk) return;
        // Image changes travel only as durable commits, after their files are uploaded;
        // readers would otherwise reference an image the server does not have yet.
        if (event.type === 'edit' && (event.edit.insertImages?.length || event.edit.removeImages?.length)) return;
        if (event.type === 'ink' && event.operation.type === 'stroke_points') {
            if (this.pending && (this.pending.pageId !== event.pageId || this.pending.strokeId !== event.operation.stroke_id)) this.flushPoints();
            this.pending ??= {pageId: event.pageId, strokeId: event.operation.stroke_id, points: []};
            this.pending.points.push(...event.operation.points);
            if (this.pending.points.length > 4096) {this.fail(1013); return;}
            this.pointsTimer ??= window.setTimeout(() => this.flushPoints(), 16);
        } else {this.flushPoints(); this.enqueue(event);}
    }
    private flushPoints(): void {
        window.clearTimeout(this.pointsTimer); this.pointsTimer = undefined;
        const pending = this.pending; this.pending = null;
        if (pending) for (let start = 0; start < pending.points.length; start += MAX_BATCH_POINTS)
            this.enqueue({type: 'ink', pageId: pending.pageId, operation: {type: 'stroke_points', stroke_id: pending.strokeId, points: pending.points.slice(start, start + MAX_BATCH_POINTS)}});
    }
    private reset(): void {
        this.generation++; this.ready = false; this.acceptingInk = false; this.pumping = false; this.queuedBytes = 0;
        for (const timer of [this.retryTimer, this.pollTimer, this.heartbeatTimer, this.pointsTimer]) window.clearTimeout(timer);
        this.retryTimer = this.pollTimer = this.heartbeatTimer = this.pointsTimer = undefined;
        this.pending = null; this.controller?.abort(); this.controller = null;
        for (const waiter of this.waiters.values()) {window.clearTimeout(waiter.timer); waiter.reject(new Error('Connection closed.'));}
        this.waiters.clear();
        const socket = this.socket; this.socket = null; socket?.close(); this.sending = Promise.resolve();
    }
    private fail(code: number, detail?: string): void {
        this.reset(); if (!this.enabled) return;
        if ([1008, 1009, 4009, 4401, 4403, 4413, 4426, 4429, 4503].includes(code)) {
            this.state({phase: 'error', viewerUrl: this.viewerUrl, detail: accessError(code) ?? detail ?? 'Synchronisation abgelehnt; lokale Änderungen bleiben gespeichert.'}); return;
        }
        this.state({phase: 'reconnecting', viewerUrl: this.viewerUrl, detail});
        this.retryTimer = window.setTimeout(() => {void this.connect();}, Math.min(500 * 2 ** this.retries++, 5000));
    }
    private wait(type: string, timeout = 30000): Promise<Record<string, unknown>> {
        if (this.waiters.has(type)) throw new Error('Duplicate protocol wait.');
        return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => {this.waiters.delete(type); reject(new Error('Serverbestätigung ausgeblieben.'));}, timeout);
            this.waiters.set(type, {resolve, reject, timer});
        });
    }
    private async send(value: unknown, socket = this.socket): Promise<void> {
        if (!socket || socket !== this.socket || socket.readyState !== WebSocket.OPEN) throw new Error('Connection closed.');
        for (const frame of syncFrames(value)) {
            // Yield under backpressure; only this transport's serial writer owns
            // the socket while a fragmented value is in flight.
            while (socket.bufferedAmount > 256000) {
                await new Promise(resolve => window.setTimeout(resolve, 10));
                if (socket !== this.socket) throw new Error('Connection replaced.');
            }
            socket.send(frame);
        }
    }
    private queuedBytes = 0;
    private enqueue(value: unknown): void {
        const kind = (value as {type?: string}).type;
        const size = ['recover_page', 'commit', 'resume_ink', 'recover_begin'].includes(kind ?? '') ? 1 : JSON.stringify(value).length, generation = this.generation;
        this.queuedBytes += size;
        if (this.queuedBytes > 2_000_000) {this.queuedBytes = 0; this.fail(1013); return;}
        this.sending = this.sending.then(async () => {if (generation === this.generation) await this.send(value);}).catch(error => {
            if (generation === this.generation) this.fail(1011, String(error));
        }).finally(() => {if (generation === this.generation) this.queuedBytes -= size;});
    }
    private async request(value: unknown, reply: string): Promise<Record<string, unknown>> {
        const waiting = this.wait(reply);
        this.enqueue(value);
        return waiting;
    }
    /** Upload every PDF and image a notebook references that the server does not have yet. */
    private async uploadAssets(notebook: Notebook, generation: number): Promise<void> {
        const pages = notebookPages(notebook);
        for (const asset of new Set(pages.flatMap(page => page.background ? [page.background.assetId] : []))) await this.upload(asset, 'pdf', generation);
        await this.uploadImages(pages.flatMap(page => (page.images ?? []).map(image => image.assetId)), generation);
    }
    private async uploadImages(assets: string[], generation: number): Promise<void> {
        for (const asset of new Set(assets)) await this.upload(asset, 'image', generation);
    }
    private async upload(asset: string, kind: 'pdf' | 'image', generation: number): Promise<void> {
        if (this.assets.has(asset)) return;
        const bytes = await (kind === 'pdf' ? this.readPdf(asset) : this.readImage(asset));
        if (generation !== this.generation) throw new Error('Connection replaced.');
        const controller = this.controller!, label = kind === 'pdf' ? 'PDF' : 'Bild';
        const timeout = window.setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch(new URL(`/api/sync/${kind}/${asset}`, this.base!), {method: 'POST', redirect: 'error', headers: {Authorization: `Bearer ${this.secret}`, 'Content-Type': kind === 'pdf' ? 'application/pdf' : 'application/octet-stream', 'X-LiveMitschrift-Publisher-Key': this.key}, body: bytes.slice().buffer as ArrayBuffer, signal: controller.signal});
            if (response.status === 404 && kind === 'image') throw new SyncProtocolError('Der Server unterstützt noch keine Bilder; bitte den Server auf Version 0.3 aktualisieren.');
            if ([400, 401, 403, 410, 413].includes(response.status)) throw new SyncProtocolError(`${label}-Übertragung abgelehnt (${response.status}); bitte Zugangsschlüssel und ${label} prüfen.`);
            if (!response.ok) throw new Error(`${label}-Übertragung fehlgeschlagen (${response.status}).`);
            this.assets.add(asset);
        } finally {window.clearTimeout(timeout);}
    }
    private async connect(): Promise<void> {
        if (!this.enabled || !this.base) return;
        const generation = ++this.generation;
        this.queuedBytes = 0; this.controller = new AbortController();
        this.state({phase: this.retries ? 'reconnecting' : 'connecting', viewerUrl: this.viewerUrl});
        try {
            const status = await this.durable.status();
            if (generation !== this.generation) return;
            const url = new URL('/ws/sync/v2/publish', this.base); url.protocol = this.base.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(url); this.socket = socket;
            const authenticated = this.wait('authenticated');
            socket.onopen = () => {if (this.socket === socket) {socket.send(JSON.stringify({type: 'authenticate', key: this.key})); this.lastReply = Date.now(); this.heartbeat(generation);}};
            socket.onmessage = event => {
                if (this.socket !== socket) return;
                try {
                    const value = JSON.parse(event.data) as Record<string, unknown>;
                    this.lastReply = Date.now();
                    if (value.type === 'pong') return;
                    const waiter = this.waiters.get(String(value.type));
                    if (!waiter) throw new Error('Unexpected synchronization reply.');
                    this.waiters.delete(String(value.type)); window.clearTimeout(waiter.timer); waiter.resolve(value);
                } catch (error) {this.fail(1008, String(error));}
            };
            socket.onclose = event => {if (this.socket === socket) this.fail(event.code, event.reason);};
            socket.onerror = () => {if (this.socket === socket) this.fail(1006);};
            await authenticated;
            const resume = await this.request({type: 'hello', secret: this.secret, forceRecovery: this.forceRecovery, ...status}, 'resume');
            if (!Number.isSafeInteger(resume.sequence) || (resume.sequence as number) < 0 || (resume.sequence as number) > status.sequence || typeof resume.sessionId !== 'string' || !/^[a-f0-9]{64}$/.test(resume.sessionId) || !Array.isArray(resume.assets) || resume.assets.length > 128 || !resume.assets.every(asset => typeof asset === 'string' && /^[a-f0-9]{64}$/.test(asset)) || typeof resume.recover !== 'boolean') throw new SyncProtocolError('Ungültiger Änderungsstand des Servers.');
            this.assets = new Set(resume.assets as string[]);
            this.viewerUrl = new URL(`/notebook/${resume.sessionId}`, this.base).href;
            this.sequence = resume.sequence as number;
            if (resume.recover) {
                const checkpoint = await this.durable.checkpoint();
                if (generation !== this.generation) return;
                await this.uploadAssets(checkpoint.notebook, generation);
                const position = this.snapshot().position, pages = notebookPages(checkpoint.notebook), page = pages.find(page => page.id === position.pageId);
                this.enqueue({type: 'recover_begin', sequence: checkpoint.sequence, head: checkpoint.head, snapshot: {type: 'notebook', notebook: notebookStructure(checkpoint.notebook), position: page ? {...position, y: Math.min(position.y, page.height), focusY: null} : {pageId: pages[0]!.id, y: 0}}});
                for (const page of pages) {
                    if (new TextEncoder().encode(JSON.stringify(page)).length > MAX_SYNC_PAGE_BYTES) throw new SyncProtocolError('Eine Seite überschreitet die 64-MB-Grenze.');
                    const staged = await this.request({type: 'recover_page', page}, 'page_staged');
                    if (staged.pageId !== page.id) throw new SyncProtocolError('Unerwartete Seitenbestätigung.');
                }
                const ack = await this.request({type: 'recover_end'}, 'ack');
                if (ack.sequence !== checkpoint.sequence) throw new SyncProtocolError('Unerwartete Wiederherstellungsbestätigung.');
                this.sequence = checkpoint.sequence; this.forceRecovery = false;
            }
            // Only now may local operations covered by the server revision go.
            await this.durable.acknowledge(this.sequence);
            if (generation !== this.generation) return;
            this.ready = true; this.retries = 0;
            this.state({phase: 'live', viewerUrl: this.viewerUrl});
            this.needsPreview = true;
            await this.pump();
        } catch (error) {if (generation === this.generation) this.fail(error instanceof SyncProtocolError ? 1008 : 1011, String(error));}
    }
    private async pump(): Promise<void> {
        if (!this.ready || this.pumping) return;
        this.pumping = true; window.clearTimeout(this.pollTimer);
        const generation = this.generation;
        try {
            while (this.ready && generation === this.generation) {
                const structureVersion = this.structureVersion;
                const next = (await this.durable.outgoing(this.sequence))[0];
                if (generation !== this.generation || !this.ready) return;
                if (!next) {if (structureVersion !== this.structureVersion) continue; break;}
                if (next.sequence !== this.sequence + 1) {this.forceRecovery = true; this.fail(1013); return;}
                const change = next.change as {type: string; notebook?: Notebook; edit?: PageEdit};
                if (change.type === 'replace') {this.forceRecovery = true; this.fail(1013); return;}
                if (change.type === 'structure' && change.notebook) {
                    this.acceptingInk = false; this.needsPreview = true; this.flushPoints();
                    await this.uploadAssets(change.notebook, generation);
                }
                if (change.type === 'edit' && change.edit?.insertImages?.length)
                    await this.uploadImages(change.edit.insertImages.map(image => image.assetId), generation);
                this.flushPoints();
                const ack = await this.request({type: 'commit', ...next}, 'ack');
                if (ack.sequence !== next.sequence) throw new SyncProtocolError('Unerwartete Änderungsbestätigung.');
                await this.durable.acknowledge(next.sequence);
                if (generation !== this.generation) return;
                this.sequence = next.sequence;
            }
            if (this.ready && generation === this.generation && this.needsPreview) this.resumePreview();
        } catch (error) {if (generation === this.generation) this.fail(error instanceof SyncProtocolError ? 1008 : 1011, String(error));}
        finally {
            if (generation === this.generation) {this.pumping = false; if (this.ready) this.pollTimer = window.setTimeout(() => {void this.pump();}, 250);}
        }
    }
    private resumePreview(): void {
        this.needsPreview = false;
        const preview = this.durable.preview?.();
        if (preview) {
            const pages = notebookPages(preview.notebook), current = pages.find(page => page.id === preview.position.pageId);
            if (current) this.enqueue({type: 'extent', pageId: current.id, height: current.height});
            const active = pages.flatMap(page => page.strokes.filter(stroke => !stroke.complete).map(stroke => ({pageId: page.id, stroke})))[0];
            if (active) this.enqueue({type: 'resume_ink', ...structuredClone(active)});
            this.enqueue({type: 'viewport', position: preview.position});
        }
        this.acceptingInk = true;
    }
    private heartbeat(generation: number): void {
        this.heartbeatTimer = window.setTimeout(() => {
            if (generation !== this.generation) return;
            if (Date.now() - this.lastReply > 45000) {this.fail(1006); return;}
            this.enqueue({type: 'ping'}); this.heartbeat(generation);
        }, 5000);
    }
}
