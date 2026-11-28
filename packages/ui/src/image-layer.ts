import type { ImageCorner, PageImage } from '@livemitschrift/core';

/**
 * Images of the current page as <img> elements between the PDF canvas and the
 * ink canvas, plus the selection frame with corner handles above the ink
 * (used by the editor only). Geometry uses container query units of the paper
 * (100cqw = 1200 document units), so zooming and a growing page need no
 * re-layout. Shared by the desktop editor (blob URLs from local files) and the
 * reader view (server URLs).
 */
export class ImageLayer {
    private readonly layer = document.createElement('div');
    private readonly frame = document.createElement('div');
    private readonly urls = new Map<string, Promise<string>>();
    private readonly elements = new Map<string, HTMLImageElement>();

    /** `source` resolves an asset to an image URL; `below` is the element the layer is placed before. */
    constructor(paper: HTMLElement, below: Element, private readonly source: (assetId: string) => Promise<string>) {
        this.layer.className = 'image-layer';
        below.before(this.layer);
        this.frame.className = 'image-selection';
        this.frame.hidden = true;
        for (const corner of ['nw', 'ne', 'sw', 'se'] satisfies ImageCorner[]) {
            const handle = document.createElement('span');
            handle.className = `image-handle image-handle-${corner}`;
            this.frame.append(handle);
        }
        paper.append(this.frame);
    }

    /** Show these images; elements of unchanged images are kept, so nothing reloads or flickers. */
    render(images: readonly PageImage[]): void {
        const previous = new Map(this.elements);
        this.elements.clear();
        this.layer.replaceChildren(...images.map(image => {
            let element = previous.get(image.id);
            if (!element || element.dataset.asset !== image.assetId) {
                element = document.createElement('img');
                element.alt = '';
                element.draggable = false;
                element.dataset.image = image.id;
                element.dataset.asset = image.assetId;
                this.load(element, image.assetId, 0);
            }
            place(element, image);
            this.elements.set(image.id, element);
            return element;
        }));
    }

    /** Show a moved or resized image before the edit is committed. */
    preview(image: PageImage): void {
        const element = this.elements.get(image.id);
        if (element) place(element, image);
        if (!this.frame.hidden) place(this.frame, image);
    }

    select(image: PageImage | null): void {
        this.frame.hidden = !image;
        if (image) place(this.frame, image);
    }

    /**
     * Show a grey placeholder until the image has loaded. A failed load is
     * retried a few times with growing delays: a reader may see an image
     * reference shortly before the server has stored the file.
     */
    private load(element: HTMLImageElement, assetId: string, attempt: number): void {
        element.classList.add('image-loading');
        element.onload = () => element.classList.remove('image-loading', 'image-missing');
        element.onerror = () => {
            this.urls.delete(assetId);
            if (attempt >= 4 || !element.isConnected) { element.classList.replace('image-loading', 'image-missing'); return; }
            window.setTimeout(() => { if (element.isConnected) this.load(element, assetId, attempt + 1); }, 1000 * 2 ** attempt);
        };
        // Setting src again restarts loading; blob URLs must not get query strings.
        this.url(assetId).then(url => { if (attempt) element.removeAttribute('src'); element.src = url; },
            () => element.onerror?.(new Event('error')));
    }

    private url(assetId: string): Promise<string> {
        let url = this.urls.get(assetId);
        if (!url) {
            // URLs are kept for the session: assets are immutable and shared between pages.
            url = this.source(assetId);
            url.catch(() => this.urls.delete(assetId));
            this.urls.set(assetId, url);
        }
        return url;
    }
}

const units = (value: number): string => `calc(100cqw * ${value / 1200})`;

function place(element: HTMLElement, image: PageImage): void {
    element.style.left = units(image.x);
    element.style.top = units(image.y);
    element.style.width = units(image.width);
    element.style.height = units(image.height);
}
