import { textBoxLayout } from '@livemitschrift/core';
import type { PageText, TextLayout } from '@livemitschrift/core';
import { linkParts } from './links.js';

const units = (value: number): string => `calc(100cqw * ${value / 1200})`;

/** Absolute ranges of the safe links in a text (https and mailto only). */
function linkRanges(text: string): {start: number; end: number; href: string}[] {
    const ranges: {start: number; end: number; href: string}[] = [];
    let offset = 0;
    for (const part of linkParts(text)) {
        if (part.href) ranges.push({start: offset, end: offset + part.text.length, href: part.href});
        offset += part.text.length;
    }
    return ranges;
}

/**
 * Text boxes of the current page above the ink, shared by the desktop editor
 * and the reader view. Each box shows exactly the lines of the shared layout
 * (one element per line, `white-space: pre`, no kerning or ligatures), so the
 * browser never wraps on its own and lines match the PDF export. Sizes use
 * container query units of the paper (100cqw = 1200 document units). Text is
 * inserted as text nodes and safe links only, never as HTML.
 */
export class TextLayer {
    private readonly layer = document.createElement('div');
    private readonly frame = document.createElement('div');
    private readonly elements = new Map<string, HTMLDivElement>();

    /** `openLink` handles link clicks (the desktop opens them externally); without it links open in a new tab. */
    constructor(paper: HTMLElement, private readonly openLink?: (href: string) => void) {
        this.layer.className = 'text-layer';
        this.frame.className = 'text-selection';
        this.frame.hidden = true;
        for (const side of ['w', 'e']) {
            const handle = document.createElement('span');
            handle.className = `text-handle text-handle-${side}`;
            this.frame.append(handle);
        }
        paper.append(this.layer, this.frame);
    }

    /** Show these boxes; unchanged boxes keep their elements (the reader re-renders on every event). */
    render(boxes: readonly PageText[], hidden: string | null = null): void {
        const previous = new Map(this.elements);
        this.elements.clear();
        this.layer.replaceChildren(...boxes.filter(box => box.id !== hidden).map(box => {
            const signature = JSON.stringify(box), old = previous.get(box.id);
            const element = old?.dataset.signature === signature ? old : this.box(box);
            element.dataset.signature = signature;
            this.elements.set(box.id, element);
            return element;
        }));
    }

    /** Show a moved or resized box before the edit is committed. */
    preview(box: PageText): void {
        const element = this.elements.get(box.id);
        if (element) element.replaceWith(this.replace(box, element));
        if (!this.frame.hidden) this.place(this.frame, box, textBoxLayout(box));
    }

    /** Selection frame with width handles; links of the selected box become clickable in the editor. */
    select(box: PageText | null): void {
        this.frame.hidden = !box;
        for (const [id, element] of this.elements) element.classList.toggle('selected', id === box?.id);
        if (box) this.place(this.frame, box, textBoxLayout(box));
    }

    private replace(box: PageText, old: HTMLDivElement): HTMLDivElement {
        const element = this.box(box);
        element.dataset.signature = JSON.stringify(box);
        element.classList.toggle('selected', old.classList.contains('selected'));
        this.elements.set(box.id, element);
        return element;
    }

    private box(box: PageText): HTMLDivElement {
        const layout = textBoxLayout(box), element = document.createElement('div');
        element.className = box.code ? 'text-box code' : 'text-box';
        element.dataset.text = box.id;
        this.place(element, box, layout);
        element.style.fontSize = units(layout.fontSize);
        element.style.lineHeight = units(layout.lineHeight);
        element.style.color = box.color;
        const links = box.code ? [] : linkRanges(box.text);
        layout.lines.forEach((line, index) => element.append(this.line(line, layout.starts[index]!, links)));
        return element;
    }

    /** One laid-out line; parts of a link that wraps across lines each link to the full URL. */
    private line(text: string, start: number, links: {start: number; end: number; href: string}[]): HTMLDivElement {
        const row = document.createElement('div'), end = start + text.length;
        row.className = 'text-line';
        let cursor = start;
        for (const link of links) {
            if (link.end <= cursor || link.start >= end) continue;
            if (link.start > cursor) row.append(text.slice(cursor - start, link.start - start));
            const anchor = document.createElement('a');
            anchor.href = link.href;
            anchor.textContent = text.slice(Math.max(link.start, cursor) - start, Math.min(link.end, end) - start);
            anchor.title = `${link.href} öffnen.`;
            anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
            if (this.openLink) anchor.addEventListener('click', event => { event.preventDefault(); this.openLink!(link.href); });
            row.append(anchor);
            cursor = Math.min(link.end, end);
        }
        if (cursor < end) row.append(text.slice(cursor - start));
        if (!row.childNodes.length) row.append('​'); // keep empty lines one line tall
        return row;
    }

    private place(element: HTMLElement, box: PageText, layout: TextLayout): void {
        element.style.left = units(box.x);
        element.style.top = units(box.y);
        element.style.width = units(box.width);
        element.style.height = units(layout.height);
    }
}
