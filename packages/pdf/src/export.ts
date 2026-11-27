import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, LineCapStyle, clip, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb, degrees } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { HIGHLIGHTER_OPACITY, notebookPdfPlacement, pressureWidth } from '@livemitschrift/core';
import type { NotePage, Topic } from '@livemitschrift/core';

const A4 = [595.28, 841.89] as const;
const MARGIN = 24;
const SCALE = (A4[0] - 2 * MARGIN) / 1200;
export const EXPORT_SLICE_HEIGHT = (A4[1] - 2 * MARGIN) / SCALE;
const MAX_EXPORT_PAGES = 2000;

/** Trim only the unused growing tail, retaining gaps and the complete PDF slide. */
export function exportContentHeight(page: NotePage): number {
    let height = page.background ? notebookPdfPlacement(page.background).height : 0;
    for (const stroke of page.strokes) for (const point of stroke.points)
        height = Math.max(height, point.y + (stroke.highlighter ? stroke.width : pressureWidth(stroke.width, point.pressure)) / 2 + 16);
    return Math.max(1, height);
}

/** A reader's private note, exported as a PDF comment at its page position. */
export interface ExportNote { number: number; x: number; y: number; text: string; updated: number }
export interface ExportNotes {
    byPage: Map<string, ExportNote[]>;
    /** Also draw numbered markers and list the texts after each page, since comments rarely print. */
    printable: boolean;
}

/**
 * Where a document position of a notebook page lands in the export: the index
 * of its A4 slice and PDF coordinates (origin bottom left) on that slice.
 */
export function exportPlacement(x: number, y: number): {slice: number; x: number; y: number} {
    const slice = Math.max(0, Math.floor(y / EXPORT_SLICE_HEIGHT));
    return {slice, x: MARGIN + x * SCALE, y: A4[1] - MARGIN - (y - slice * EXPORT_SLICE_HEIGHT) * SCALE};
}

const NOTE_ICON = 18, NOTE_COLOR = rgb(1, .85, .3), NOTE_TEXT = rgb(.29, .23, 0);

/** A standard Text annotation (sticky note); UTF-16 contents keep every character. */
function addNoteComment(result: PDFDocument, target: PDFPage, note: ExportNote): void {
    const place = exportPlacement(note.x, note.y);
    const annotation = result.context.obj({
        Type: 'Annot', Subtype: 'Text', Name: 'Comment', Open: false, F: 4,
        Rect: [place.x, place.y - NOTE_ICON, place.x + NOTE_ICON, place.y], C: [1, .85, .3],
        T: PDFHexString.fromText(`Notiz ${note.number}`), Contents: PDFHexString.fromText(note.text),
        M: PDFString.fromDate(new Date(note.updated)),
    });
    target.node.addAnnot(result.context.register(annotation));
}

function drawNoteMarker(target: PDFPage, font: PDFFont, note: ExportNote): void {
    const place = exportPlacement(note.x, note.y), label = String(note.number), size = 8;
    target.drawCircle({x: place.x, y: place.y, size: 7, color: NOTE_COLOR, borderColor: NOTE_TEXT, borderWidth: .5});
    target.drawText(label, {x: place.x - font.widthOfTextAtSize(label, size) / 2, y: place.y - size * .35, size, font, color: NOTE_TEXT});
}

/** The standard font only covers WinAnsi; other characters print as "?" on the text pages. */
function printable(font: PDFFont, text: string): string {
    return [...text].map(char => { try { font.encodeText(char); return char; } catch { return '?'; } }).join('');
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const word of paragraph.split(' ')) {
            const next = line ? `${line} ${word}` : word;
            if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
            else { lines.push(line); line = word; }
            // Break single words longer than a line.
            while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
                let cut = line.length - 1;
                while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
                lines.push(line.slice(0, cut)); line = line.slice(cut);
            }
        }
        lines.push(line);
    }
    return lines;
}

/** Text pages "Notizen zu Seite N" listing the numbered notes of one notebook page. */
function addNoteText(result: PDFDocument, font: PDFFont, bold: PDFFont, title: string, notes: ExportNote[]): void {
    const size = 10, leading = 14, width = A4[0] - 2 * MARGIN - 24;
    let target = result.addPage([...A4]), y = A4[1] - MARGIN - 16;
    target.drawText(printable(bold, title), {x: MARGIN, y, size: 13, font: bold});
    y -= 28;
    for (const note of notes) {
        const lines = wrap(font, printable(font, note.text), size, width);
        for (const [index, line] of lines.entries()) {
            if (y < MARGIN + leading) { target = result.addPage([...A4]); y = A4[1] - MARGIN - 16; }
            if (index === 0) target.drawText(`${note.number}.`, {x: MARGIN, y, size, font: bold});
            target.drawText(line, {x: MARGIN + 24, y, size, font});
            y -= leading;
        }
        y -= 6;
    }
}

function drawInk(target: PDFPage, page: NotePage, offset: number): void {
    const y = (value: number) => A4[1] - MARGIN - (value - offset) * SCALE;
    for (const stroke of page.strokes) {
        const color = rgb(parseInt(stroke.color.slice(1, 3), 16) / 255, parseInt(stroke.color.slice(3, 5), 16) / 255, parseInt(stroke.color.slice(5, 7), 16) / 255);
        if (stroke.highlighter) {
            // One translucent path, as on screen; the page clip trims other slices.
            let top = Infinity, bottom = -Infinity;
            for (const point of stroke.points) {top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);}
            if (bottom + stroke.width < offset || top - stroke.width > offset + EXPORT_SLICE_HEIGHT) continue;
            const path = stroke.points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y - offset}`).join(' ') + (stroke.points.length === 1 ? ` L${stroke.points[0]!.x} ${stroke.points[0]!.y - offset}` : '');
            target.drawSvgPath(path, { x: MARGIN, y: A4[1] - MARGIN, scale: SCALE, borderColor: color, borderWidth: stroke.width,
                borderOpacity: HIGHLIGHTER_OPACITY, borderLineCap: LineCapStyle.Round });
            continue;
        }
        for (let index = 0; index < stroke.points.length; index++) {
            const point = stroke.points[index]!, previous = stroke.points[index - 1];
            if (previous && Math.max(previous.y, point.y) + stroke.width >= offset && Math.min(previous.y, point.y) - stroke.width <= offset + EXPORT_SLICE_HEIGHT)
                target.drawLine({ start: { x: MARGIN + previous.x * SCALE, y: y(previous.y) }, end: { x: MARGIN + point.x * SCALE, y: y(point.y) }, color,
                    thickness: pressureWidth(stroke.width, (previous.pressure + point.pressure) / 2) * SCALE, lineCap: LineCapStyle.Round });
            if (point.y + stroke.width >= offset && point.y - stroke.width <= offset + EXPORT_SLICE_HEIGHT)
                target.drawCircle({ x: MARGIN + point.x * SCALE, y: y(point.y), size: pressureWidth(stroke.width, point.pressure) * SCALE / 2, color });
        }
    }
}

/** Vector export; PDF backgrounds and ink share the editor's document transform. */
export async function exportTopicPdf(topic: Topic, readAsset: (id: string, pageNumber?: number) => Promise<Uint8Array>,
    options: {pagewiseAssets?: boolean; notes?: ExportNotes} = {}): Promise<Uint8Array> {
    // Notes below the ink still need their slice.
    const contentHeight = (page: NotePage): number => Math.max(exportContentHeight(page),
        ...(options.notes?.byPage.get(page.id) ?? []).map(note => note.y + NOTE_ICON / SCALE));
    const count = topic.pages.reduce((total, page) => total + Math.ceil(contentHeight(page) / EXPORT_SLICE_HEIGHT), 0);
    if (count > MAX_EXPORT_PAGES) throw new Error('Der Export umfasst mehr als 2000 Druckseiten. Bitte das Thema aufteilen.');
    const result = await PDFDocument.create();
    result.setTitle(topic.title); result.setCreator('LiveMitschrift');
    const documents = new Map<string, PDFDocument>();
    const fonts = options.notes?.printable ? {regular: await result.embedFont(StandardFonts.Helvetica), bold: await result.embedFont(StandardFonts.HelveticaBold)} : null;
    for (const [pageIndex, page] of topic.pages.entries()) {
        const pageNotes = options.notes?.byPage.get(page.id) ?? [];
        const background = page.background;
        let embedded: Awaited<ReturnType<PDFDocument['embedPage']>> | undefined;
        let rotation = 0, sourceWidth = 0, sourceHeight = 0;
        if (background) {
            // Readers fetch only referenced PDF pages. Each extracted file has
            // one page, while desktop assets retain the original page numbering.
            const key = options.pagewiseAssets ? `${background.assetId}/${background.pageNumber}` : background.assetId;
            let source = documents.get(key);
            if (!source) { source = await PDFDocument.load(await readAsset(background.assetId, options.pagewiseAssets ? background.pageNumber : undefined)); documents.set(key, source); }
            const original = source.getPage(options.pagewiseAssets ? 0 : background.pageNumber - 1), crop = original.getCropBox(), media = original.getMediaBox();
            const left = Math.max(crop.x, media.x), bottom = Math.max(crop.y, media.y);
            const right = Math.min(crop.x + crop.width, media.x + media.width), top = Math.min(crop.y + crop.height, media.y + media.height);
            if (right <= left || top <= bottom) throw new Error('Ungültiger PDF-Seitenausschnitt.');
            rotation = ((original.getRotation().angle % 360) + 360) % 360;
            if (![0, 90, 180, 270].includes(rotation)) throw new Error('Nicht unterstützte PDF-Seitendrehung.');
            // A truly blank source has no Contents; embedding an empty stream is valid.
            if (!original.node.Contents()) original.node.set(PDFName.of('Contents'), source.context.register(source.context.flateStream('')));
            embedded = await result.embedPage(original, { left, bottom, right, top });
            sourceWidth = right - left; sourceHeight = top - bottom;
            const unit = original.node.get(PDFName.of('UserUnit'));
            if (unit instanceof PDFNumber && unit.asNumber() <= 0) throw new Error('Ungültige PDF-Skalierung.');
        }
        for (let offset = 0, slice = 0; offset < contentHeight(page); offset += EXPORT_SLICE_HEIGHT, slice++) {
            const target = result.addPage([...A4]);
            target.pushOperators(pushGraphicsState(), rectangle(MARGIN, MARGIN, A4[0] - 2 * MARGIN, A4[1] - 2 * MARGIN), clip(), endPath());
            if (embedded && background) {
                const placement = notebookPdfPlacement(background), x = MARGIN + placement.x * SCALE;
                const bottom = A4[1] - MARGIN - (placement.height - offset) * SCALE;
                const width = placement.width * SCALE, height = placement.height * SCALE;
                const factor = width / (rotation % 180 ? sourceHeight : sourceWidth);
                target.drawPage(embedded, { x: x + (rotation >= 180 ? width : 0), y: bottom + (rotation === 90 || rotation === 180 ? height : 0),
                    width: sourceWidth * factor, height: sourceHeight * factor, rotate: degrees(-rotation) });
            }
            drawInk(target, page, offset);
            target.pushOperators(popGraphicsState());
            for (const note of pageNotes) {
                if (exportPlacement(note.x, note.y).slice !== slice) continue;
                if (fonts) drawNoteMarker(target, fonts.bold, note);
                addNoteComment(result, target, note);
            }
        }
        if (fonts && pageNotes.length) addNoteText(result, fonts.regular, fonts.bold, `${topic.title} · Notizen zu Seite ${pageIndex + 1}`, pageNotes);
    }
    return result.save();
}
