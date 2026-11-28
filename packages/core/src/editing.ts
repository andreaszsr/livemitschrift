import type { Point, Stroke } from "./protocol.js";
import type { PageEdit } from "./notebook.js";
import type { PageImage } from "./images.js";
import type { PageText } from "./texts.js";
/** Image and text box changes of one edit: objects inserted and the replaced or deleted originals. */
export interface PageObjects {
    images?: {insert: PageImage[]; removed: PageImage[]};
    texts?: {insert: PageText[]; removed: PageText[]};
}
import { createStrokeId } from "./session.js";
export function hitStroke(stroke: Stroke, from: Point, to: Point, radius: number): boolean {
    const distance = (p: Point, a: Point, b: Point): number => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    for (let index = 0; index < stroke.points.length; index++) {
        const a = stroke.points[Math.max(0, index - 1)]!, b = stroke.points[index]!;
        // Segment intersection also catches a fast eraser crossing a thin stroke.
        const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
        const intersects = cross(a, b, from) * cross(a, b, to) <= 0 && cross(from, to, a) * cross(from, to, b) <= 0
            && Math.max(Math.min(a.x, b.x), Math.min(from.x, to.x)) <= Math.min(Math.max(a.x, b.x), Math.max(from.x, to.x))
            && Math.max(Math.min(a.y, b.y), Math.min(from.y, to.y)) <= Math.min(Math.max(a.y, b.y), Math.max(from.y, to.y));
        if (intersects || Math.min(distance(a, from, to), distance(b, from, to), distance(from, a, b), distance(to, a, b)) <= radius + stroke.width / 2)
            return true;
    }
    return false;
}
interface HistoryEntry {
    forward: PageEdit;
    backward: PageEdit;
}
/** One entry per finished pen/eraser gesture. New edits invalidate redo. */
export class EditHistory {
    private past: HistoryEntry[] = [];
    private future: HistoryEntry[] = [];
    get canUndo(): boolean { return this.past.length > 0; }
    get canRedo(): boolean { return this.future.length > 0; }
    /** Record one undoable step; image and text box changes are optional and travel in the same edit. */
    record(pageId: string, height: number, insert: Stroke[], removed: Stroke[], objects: PageObjects = {}): PageEdit {
        const images = objects.images ?? {insert: [], removed: []}, texts = objects.texts ?? {insert: [], removed: []};
        const forward = this.edit(pageId, height, insert, removed.map(stroke => stroke.id), {images: {insert: images.insert, removed: images.removed}, texts: {insert: texts.insert, removed: texts.removed}});
        const backward = this.edit(pageId, height, removed, insert.map(stroke => stroke.id), {images: {insert: images.removed, removed: images.insert}, texts: {insert: texts.removed, removed: texts.insert}});
        this.past.push({ forward, backward });
        if (this.past.length > 200)
            this.past.shift();
        this.future = [];
        return forward;
    }
    undo(): PageEdit | null { const entry = this.past.pop(); if (!entry)
        return null; this.future.push(entry); return { ...structuredClone(entry.backward), id: createStrokeId() }; }
    redo(): PageEdit | null { const entry = this.future.pop(); if (!entry)
        return null; this.past.push(entry); return { ...structuredClone(entry.forward), id: createStrokeId() }; }
    private edit(pageId: string, height: number, insert: Stroke[], remove: string[], objects: Required<PageObjects>): PageEdit {
        const edit: PageEdit = { id: createStrokeId(), pageId, height, insert: structuredClone(insert), remove: [...remove] };
        // Stroke-only edits keep their previous shape; object lists appear only when used.
        const {images, texts} = objects;
        if (images.insert.length || images.removed.length) { edit.insertImages = structuredClone(images.insert); edit.removeImages = images.removed.map(image => image.id); }
        if (texts.insert.length || texts.removed.length) { edit.insertTexts = structuredClone(texts.insert); edit.removeTexts = texts.removed.map(box => box.id); }
        return edit;
    }
}
