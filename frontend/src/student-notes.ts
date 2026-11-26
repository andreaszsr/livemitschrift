/**
 * Private reader notes. They live only in this browser (localStorage) and in
 * files the reader downloads; nothing here touches the network. Positions are
 * document coordinates of a notebook page (width 1200), never screen pixels.
 */
export interface StudentNote {
    id: string;
    pageId: string;
    x: number;
    y: number;
    text: string;
    /** Milliseconds since the epoch; the newer version wins when importing. */
    created: number;
    updated: number;
}

export const MAX_NOTES = 1000;
export const MAX_NOTE_LENGTH = 2000;
const FORMAT = 'livemitschrift-notes';
const VERSION = 1;

/** The part of the Storage API used here, so tests can pass a fake. */
export interface NoteStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function validNote(value: unknown): value is StudentNote {
    if (!value || typeof value !== 'object') return false;
    const note = value as Record<string, unknown>;
    return identity(note.id) && identity(note.pageId)
        && typeof note.x === 'number' && Number.isFinite(note.x) && note.x >= 0 && note.x <= 1200
        && typeof note.y === 'number' && Number.isFinite(note.y) && note.y >= 0 && note.y <= 1_000_000_000
        && typeof note.text === 'string' && note.text.trim().length > 0 && [...note.text].length <= MAX_NOTE_LENGTH
        && time(note.created) && time(note.updated);
}

/** Read notes from stored or imported JSON; invalid entries are dropped, not fatal. */
export function parseNotes(text: string): StudentNote[] {
    const value: unknown = JSON.parse(text);
    const list = Array.isArray(value) ? value
        : value && typeof value === 'object' && Array.isArray((value as {notes?: unknown}).notes) ? (value as {notes: unknown[]}).notes : null;
    if (!list) throw new Error('Keine LiveMitschrift-Notizen.');
    const notes = new Map<string, StudentNote>();
    for (const item of list) {
        if (!validNote(item)) continue;
        const {id, pageId, x, y, text, created, updated} = item;
        notes.set(id, {id, pageId, x, y, text, created, updated});
    }
    return [...notes.values()].slice(0, MAX_NOTES);
}

export function serializeNotes(notes: StudentNote[], notebook = ''): string {
    return JSON.stringify({format: FORMAT, version: VERSION, notebook, notes});
}

/** Imported notes replace stored ones with the same id only if they are newer. */
export function mergeNotes(current: StudentNote[], imported: StudentNote[]): {notes: StudentNote[]; added: number; updated: number} {
    const notes = new Map(current.map(note => [note.id, note]));
    let added = 0, updated = 0;
    for (const note of imported) {
        const existing = notes.get(note.id);
        if (!existing) {
            if (notes.size >= MAX_NOTES) break;
            added++;
        } else if (note.updated > existing.updated) updated++;
        else continue;
        notes.set(note.id, note);
    }
    return {notes: [...notes.values()], added, updated};
}

/** Notes of one page in reading order (top to bottom, then left to right), numbered from 1. */
export function pageNotes(notes: StudentNote[], pageId: string): {note: StudentNote; number: number}[] {
    return notes.filter(note => note.pageId === pageId)
        .sort((a, b) => a.y - b.y || a.x - b.x || a.created - b.created)
        .map((note, index) => ({note, number: index + 1}));
}

export function noteId(): string {
    return crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4)), part => part.toString(16)).join('-');
}

/** Normalize user text; null means the note would be empty or too long. */
export function noteText(text: string): string | null {
    const value = text.replace(/\r\n?/g, '\n').trim();
    return value && [...value].length <= MAX_NOTE_LENGTH ? value : null;
}

/** localStorage access that degrades to an empty list when storage is unavailable. */
export class NoteStore {
    private notes: StudentNote[] = [];

    constructor(private readonly storage: NoteStorage | null, private readonly key: string) {
        try {
            const text = storage?.getItem(key);
            if (text) this.notes = parseNotes(text);
        } catch { /* Unreadable notes are ignored and replaced on the next save. */ }
    }

    get all(): StudentNote[] { return [...this.notes]; }

    /** Throws when the browser refuses to store (private mode, quota). */
    replace(notes: StudentNote[]): void {
        if (!this.storage) throw new Error('Dieser Browser erlaubt keine lokale Speicherung.');
        this.storage.setItem(this.key, serializeNotes(notes));
        this.notes = [...notes];
    }

    save(note: StudentNote): void {
        const others = this.notes.filter(item => item.id !== note.id);
        if (others.length === this.notes.length && others.length >= MAX_NOTES) throw new Error(`Höchstens ${MAX_NOTES} Notizen pro Notizbuch.`);
        this.replace([...others, note]);
    }

    remove(id: string): void { this.replace(this.notes.filter(note => note.id !== id)); }
}
