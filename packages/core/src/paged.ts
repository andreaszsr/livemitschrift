import { validNotebookSnapshot } from './notebook.js';
import type { Notebook, NotebookSnapshot, NotePage } from './notebook.js';

export const MAX_SYNC_FRAME_BYTES = 256_000;
export const MAX_SYNC_TRANSFER_BYTES = 128_000_000;
export const MAX_SYNC_PAGE_BYTES = 64_000_000;
const CHUNK_CHARACTERS = 32_000;
const encoder = new TextEncoder();

/** Framing bounds WebSocket messages independently of notebook size. */
export function* syncFrames(value: unknown): Generator<string> {
    const text = JSON.stringify(value);
    if (encoder.encode(text).length > MAX_SYNC_TRANSFER_BYTES) throw new Error('Synchronization transfer limit reached.');
    if (text.length <= CHUNK_CHARACTERS) { yield text; return; }
    yield JSON.stringify({type: 'transfer_start'});
    for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + CHUNK_CHARACTERS);
        // Keep a Unicode scalar intact for Python's UTF-8 decoder as well as JS.
        const last = text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end--;
        yield JSON.stringify({type: 'transfer_chunk', text: text.slice(start, end)});
        start = end;
    }
    yield JSON.stringify({type: 'transfer_end'});
}

export class SyncTransfer {
    private parts: string[] | null = null;
    private bytes = 0;
    receive(text: string): Record<string, unknown> | null {
        if (encoder.encode(text).length > MAX_SYNC_FRAME_BYTES) throw new Error('Synchronization frame limit reached.');
        const value = JSON.parse(text) as Record<string, unknown>;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a synchronization message.');
        if (value.type === 'transfer_start') {
            if (this.parts) throw new Error('Nested synchronization transfer.');
            this.parts = []; this.bytes = 0; return null;
        }
        if (value.type === 'transfer_chunk') {
            if (!this.parts || typeof value.text !== 'string') throw new Error('Unexpected synchronization chunk.');
            this.bytes += encoder.encode(value.text).length;
            if (this.bytes > MAX_SYNC_TRANSFER_BYTES) throw new Error('Synchronization transfer limit reached.');
            this.parts.push(value.text); return null;
        }
        if (value.type === 'transfer_end') {
            if (!this.parts) throw new Error('Unexpected synchronization end.');
            const joined = this.parts.join(''); this.parts = null;
            const result: unknown = JSON.parse(joined);
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected a synchronization object.');
            return result as Record<string, unknown>;
        }
        if (this.parts && value.type !== 'pong') throw new Error('Interrupted synchronization transfer.');
        return value;
    }
}

export function notebookStructure(notebook: Notebook): Notebook {
    return {...notebook, topics: notebook.topics.map(topic => ({...topic, pages: topic.pages.map(page => ({...page, strokes: []}))}))};
}

/** The existing geometry validator is applied per page, without a notebook-wide ink cap. */
export function validSyncPage(value: unknown): value is NotePage {
    const page = value as NotePage;
    if (!page || typeof page.id !== 'string') return false;
    return validNotebookSnapshot({type: 'notebook', notebook: {id: 'validation', title: 'Validation', topics: [{id: 'validation-topic', title: 'Validation', pages: [page]}]}, position: {pageId: page.id, y: 0}} satisfies NotebookSnapshot);
}
