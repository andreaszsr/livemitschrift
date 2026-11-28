import type { Operation, PageSize, PdfBackground, Point, Stroke } from "./protocol.js";
import { validPdfBackground } from "./pdf.js";
import { MAX_PAGE_IMAGES, validPageImage } from "./images.js";
import type { PageImage } from "./images.js";
import { MAX_PAGE_TEXTS, validPageText } from "./texts.js";
import type { PageText } from "./texts.js";
export const MAX_DOCUMENT_HEIGHT = 1000000000;
export const MAX_NOTEBOOK_BYTES = 16000000;
export const MAX_NOTEBOOK_POINTS = 2000000;
export const MAX_NOTEBOOK_PAGES = 1000;
export interface NotePage extends PageSize {
    id: string;
    title: string;
    background: PdfBackground | null;
    strokes: Stroke[];
    /** Absent on pages without images (and from older clients). */
    images?: PageImage[];
    /** Absent on pages without text boxes. */
    texts?: PageText[];
    nextOrder: number;
}
export interface Topic {
    id: string;
    title: string;
    pages: NotePage[];
}
export interface Notebook {
    id: string;
    title: string;
    topics: Topic[];
}
export interface ViewPosition {
    pageId: string;
    y: number;
    focusY?: number | null;
}
export interface PageEdit {
    id: string;
    pageId: string;
    insert: Stroke[];
    remove: string[];
    /** Image changes; absent when an edit touches strokes only, so such edits stay readable for older servers. */
    insertImages?: PageImage[];
    removeImages?: string[];
    /** Text box changes; absent when unused, like the image fields. */
    insertTexts?: PageText[];
    removeTexts?: string[];
    height: number;
}
export type NotebookEvent = {
    type: "ink";
    pageId: string;
    operation: Operation;
} | {
    type: "edit";
    edit: PageEdit;
} | {
    type: "viewport";
    position: ViewPosition;
} | {
    type: "extent";
    pageId: string;
    height: number;
} | {
    /** Transient laser pointer in document coordinates; null hides it. */
    type: "pointer";
    pageId: string;
    point: { x: number; y: number } | null;
};
export interface NotebookSnapshot {
    type: "notebook";
    notebook: Notebook;
    position: ViewPosition;
}
export type NotebookMessage = NotebookSnapshot | NotebookEvent | {
    type: "source_status";
    connected: boolean;
} | {
    type: "pong";
};
export function notebookPages(notebook: Notebook): NotePage[] { return notebook.topics.flatMap(topic => topic.pages); }
export function findPage(notebook: Notebook, id: string): NotePage {
    const page = notebookPages(notebook).find(page => page.id === id);
    if (!page)
        throw new Error("Unknown notebook page.");
    return page;
}
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function validIdentity(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value); }
export function validTitle(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && [...value].length <= 200; }
export function validHeight(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_DOCUMENT_HEIGHT; }
export function validNotePoint(value: unknown, height = MAX_DOCUMENT_HEIGHT): value is Point {
    return record(value) && typeof value.x === "number" && Number.isFinite(value.x) && value.x >= 0 && value.x <= 1200
        && typeof value.y === "number" && Number.isFinite(value.y) && value.y >= 0 && value.y <= height
        && typeof value.pressure === "number" && Number.isFinite(value.pressure) && value.pressure >= 0 && value.pressure <= 1;
}
export function validNoteStroke(value: unknown, height = MAX_DOCUMENT_HEIGHT): value is Stroke {
    return record(value) && validIdentity(value.id) && typeof value.color === "string" && /^#[a-fA-F0-9]{6}$/.test(value.color)
        && typeof value.width === "number" && Number.isFinite(value.width) && value.width >= .5 && value.width <= 20
        && Number.isSafeInteger(value.order) && (value.order as number) >= 0 && typeof value.complete === "boolean"
        && (value.highlighter === undefined || value.highlighter === true)
        && Array.isArray(value.points) && value.points.length > 0 && value.points.length <= 100000 && value.points.every(point => validNotePoint(point, height));
}
export function validPageEdit(value: unknown): value is PageEdit {
    if (!record(value) || !validIdentity(value.id) || !validIdentity(value.pageId) || !validHeight(value.height))
        return false;
    const height = value.height as number;
    const insertImages: unknown = value.insertImages ?? [], removeImages: unknown = value.removeImages ?? [];
    const insertTexts: unknown = value.insertTexts ?? [], removeTexts: unknown = value.removeTexts ?? [];
    return Array.isArray(value.insert) && value.insert.length <= 1000 && value.insert.every(stroke => validNoteStroke(stroke, height) && stroke.complete)
        && Array.isArray(value.remove) && value.remove.length <= 1000 && value.remove.every(validIdentity)
        && new Set(value.insert.map(stroke => stroke.id)).size === value.insert.length && new Set(value.remove).size === value.remove.length
        && Array.isArray(insertImages) && insertImages.length <= MAX_PAGE_IMAGES && insertImages.every(image => validPageImage(image, height))
        && Array.isArray(removeImages) && removeImages.length <= MAX_PAGE_IMAGES && removeImages.every(validIdentity)
        && new Set(insertImages.map(image => (image as PageImage).id)).size === insertImages.length && new Set(removeImages).size === removeImages.length
        && Array.isArray(insertTexts) && insertTexts.length <= MAX_PAGE_TEXTS && insertTexts.every(box => validPageText(box, height))
        && Array.isArray(removeTexts) && removeTexts.length <= MAX_PAGE_TEXTS && removeTexts.every(validIdentity)
        && new Set(insertTexts.map(box => (box as PageText).id)).size === insertTexts.length && new Set(removeTexts).size === removeTexts.length;
}
export function validNotebookSnapshot(value: unknown): value is NotebookSnapshot {
    if (!record(value) || value.type !== "notebook" || !record(value.notebook) || !validIdentity(value.notebook.id)
        || !validTitle(value.notebook.title) || !Array.isArray(value.notebook.topics) || value.notebook.topics.length === 0
        || !record(value.position) || !validIdentity(value.position.pageId) || typeof value.position.y !== "number" || !Number.isFinite(value.position.y) || value.position.y < 0)
        return false;
    const ids = new Set<string>();
    let pages = 0, points = 0;
    let current: NotePage | undefined;
    for (const topic of value.notebook.topics) {
        if (!record(topic) || !validIdentity(topic.id) || ids.has(topic.id) || !validTitle(topic.title) || !Array.isArray(topic.pages) || !topic.pages.length)
            return false;
        ids.add(topic.id);
        for (const page of topic.pages) {
            if (++pages > MAX_NOTEBOOK_PAGES || !record(page) || !validIdentity(page.id) || ids.has(page.id) || !validTitle(page.title)
                || page.width !== 1200 || !validHeight(page.height) || !Number.isSafeInteger(page.nextOrder) || (page.nextOrder as number) < 0
                || (page.background != null && !validPdfBackground(page.background, MAX_NOTEBOOK_PAGES)) || !Array.isArray(page.strokes) || page.strokes.length > 50000)
                return false;
            ids.add(page.id);
            if (page.images !== undefined && !validPageImages(page.images, page.height as number, page.nextOrder as number))
                return false;
            if (page.texts !== undefined && !validPageTexts(page.texts, page.height as number, page.nextOrder as number))
                return false;
            const strokes = new Set<string>(), orders = new Set<number>();
            for (let index = 0; index < page.strokes.length; index++) {
                const stroke: unknown = page.strokes[index];
                if (!validNoteStroke(stroke, page.height) || strokes.has(stroke.id) || orders.has(stroke.order!) || stroke.order! >= (page.nextOrder as number)
                    || (!stroke.complete && index !== page.strokes.length - 1))
                    return false;
                strokes.add(stroke.id);
                orders.add(stroke.order!);
                points += stroke.points.length;
                if (points > MAX_NOTEBOOK_POINTS)
                    return false;
            }
            if (page.id === value.position.pageId)
                current = page as unknown as NotePage;
        }
    }
    return current !== undefined && value.position.y <= current.height && (value.position.focusY == null
        || (typeof value.position.focusY === "number" && Number.isFinite(value.position.focusY) && value.position.focusY >= 0 && value.position.focusY <= current.height));
}
function validPageImages(value: unknown, height: number, nextOrder: number): boolean {
    if (!Array.isArray(value) || value.length > MAX_PAGE_IMAGES)
        return false;
    const ids = new Set<string>();
    for (const image of value) {
        if (!validPageImage(image, height) || ids.has(image.id) || image.order >= nextOrder)
            return false;
        ids.add(image.id);
    }
    return true;
}
function validPageTexts(value: unknown, height: number, nextOrder: number): boolean {
    if (!Array.isArray(value) || value.length > MAX_PAGE_TEXTS)
        return false;
    const ids = new Set<string>();
    for (const box of value) {
        if (!validPageText(box, height) || ids.has(box.id) || box.order >= nextOrder)
            return false;
        ids.add(box.id);
    }
    return true;
}
export function parseNotebookMessage(text: string): NotebookMessage {
    const value: unknown = JSON.parse(text);
    if (validNotebookSnapshot(value))
        return value;
    if (!record(value))
        throw new Error("Invalid notebook message.");
    if (value.type === "pong")
        return { type: "pong" };
    if (value.type === "source_status" && typeof value.connected === "boolean")
        return { type: "source_status", connected: value.connected };
    if (value.type === "viewport" && record(value.position) && validIdentity(value.position.pageId)
        && typeof value.position.y === "number" && Number.isFinite(value.position.y) && value.position.y >= 0 && value.position.y <= MAX_DOCUMENT_HEIGHT
        && (value.position.focusY == null || (typeof value.position.focusY === "number" && Number.isFinite(value.position.focusY) && value.position.focusY >= 0 && value.position.focusY <= MAX_DOCUMENT_HEIGHT)))
        return value as unknown as NotebookEvent;
    if (value.type === "extent" && validIdentity(value.pageId) && validHeight(value.height))
        return value as unknown as NotebookEvent;
    if (value.type === "pointer" && validIdentity(value.pageId) && (value.point === null || (record(value.point)
        && typeof value.point.x === "number" && Number.isFinite(value.point.x) && value.point.x >= 0 && value.point.x <= 1200
        && typeof value.point.y === "number" && Number.isFinite(value.point.y) && value.point.y >= 0 && value.point.y <= MAX_DOCUMENT_HEIGHT)))
        return { type: "pointer", pageId: value.pageId, point: value.point === null ? null : { x: value.point.x as number, y: value.point.y as number } };
    if (value.type === "edit" && validPageEdit(value.edit))
        return value as unknown as NotebookEvent;
    if (value.type === "ink" && validIdentity(value.pageId) && record(value.operation)) {
        const op = value.operation;
        if (op.type === "stroke_start" && validNoteStroke(op.stroke) && !op.stroke.complete && op.stroke.points.length === 1)
            return value as unknown as NotebookEvent;
        if (validIdentity(op.stroke_id) && (op.type === "stroke_end" || (op.type === "stroke_points" && Array.isArray(op.points) && op.points.length > 0 && op.points.length <= 128 && op.points.every(point => validNotePoint(point)))))
            return value as unknown as NotebookEvent;
    }
    throw new Error("Invalid notebook message.");
}
/** Apply a validated server event to the reader's mirror, never to a desktop. */
export function applyNotebookEvent(notebook: Notebook, event: NotebookEvent): void {
    if (event.type === "pointer")
        return;
    if (event.type === "viewport") {
        const page = findPage(notebook, event.position.pageId);
        if (event.position.y > page.height)
            throw new Error("Viewport outside page.");
        return;
    }
    const page = findPage(notebook, event.type === "edit" ? event.edit.pageId : event.pageId);
    if (event.type === "extent") {
        page.height = Math.max(page.height, event.height);
        return;
    }
    if (event.type === "edit") {
        const ids = new Set(event.edit.remove);
        const next = page.strokes.filter(stroke => !ids.has(stroke.id));
        for (const stroke of event.edit.insert) {
            if (next.some(existing => existing.id === stroke.id || existing.order === stroke.order))
                throw new Error("Conflicting stroke identity or order.");
            next.push(structuredClone(stroke));
            page.nextOrder = Math.max(page.nextOrder, stroke.order! + 1);
        }
        page.strokes = next.sort((a, b) => a.order! - b.order!);
        if (event.edit.insertImages?.length || event.edit.removeImages?.length) {
            const removed = new Set(event.edit.removeImages ?? []);
            const images = (page.images ?? []).filter(image => !removed.has(image.id));
            for (const image of event.edit.insertImages ?? []) {
                if (images.some(existing => existing.id === image.id))
                    throw new Error("Conflicting image identity.");
                images.push(structuredClone(image));
                page.nextOrder = Math.max(page.nextOrder, image.order + 1);
            }
            if (images.length > MAX_PAGE_IMAGES)
                throw new Error("Too many images on this page.");
            page.images = images.sort((a, b) => a.order - b.order);
        }
        if (event.edit.insertTexts?.length || event.edit.removeTexts?.length) {
            const removed = new Set(event.edit.removeTexts ?? []);
            const texts = (page.texts ?? []).filter(box => !removed.has(box.id));
            for (const box of event.edit.insertTexts ?? []) {
                if (texts.some(existing => existing.id === box.id))
                    throw new Error("Conflicting text box identity.");
                texts.push(structuredClone(box));
                page.nextOrder = Math.max(page.nextOrder, box.order + 1);
            }
            if (texts.length > MAX_PAGE_TEXTS)
                throw new Error("Too many text boxes on this page.");
            page.texts = texts.sort((a, b) => a.order - b.order);
        }
        page.height = Math.max(page.height, event.edit.height);
        return;
    }
    const op = event.operation;
    if (op.type === "stroke_start") {
        if (page.strokes.some(stroke => !stroke.complete || stroke.id === op.stroke.id || stroke.order === op.stroke.order))
            throw new Error("Conflicting active stroke.");
        page.strokes.push(structuredClone(op.stroke));
        page.nextOrder = Math.max(page.nextOrder, op.stroke.order! + 1);
        return;
    }
    const stroke = page.strokes.find(stroke => stroke.id === op.stroke_id);
    if (!stroke || stroke.complete)
        throw new Error("The stroke is not active.");
    if (op.type === "stroke_end")
        stroke.complete = true;
    else {
        if (stroke.points.length + op.points.length > 100000 || op.points.some(point => point.y > page.height))
            throw new Error("Stroke outside page limits.");
        stroke.points.push(...op.points);
    }
}
