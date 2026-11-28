import type { ImageCorner, PageImage } from '@livemitschrift/core';

/**
 * Images of the current page as <img> elements between the PDF canvas and the
 * ink canvas, plus the selection frame with corner handles above the ink.
 * Geometry uses container query units of the paper (100cqw = 1200 document
 * units), so zooming and a growing page need no re-layout.
 */
export class ImageLayer {
    private readonly layer = document.createElement('div');
    private readonly frame = document.createElement('div');
    private readonly urls = new Map<string, Promise<string>>();
    private readonly elements = new Map<string, HTMLImageElement>();

    constructor(paper: HTMLElement, below: Element, private readonly readAsset: (assetId: string) => Promise<Uint8Array>) {
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

    render(images: readonly PageImage[]): void {
        this.elements.clear();
        this.layer.replaceChildren(...images.map(image => {
            const element = document.createElement('img');
            element.alt = '';
            element.draggable = false;
            element.dataset.image = image.id;
            place(element, image);
            this.elements.set(image.id, element);
            void this.url(image.assetId).then(url => { element.src = url; }, () => { element.classList.add('image-missing'); });
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

    private url(assetId: string): Promise<string> {
        let url = this.urls.get(assetId);
        if (!url) {
            // Object URLs are kept for the session: assets are immutable and shared between pages.
            url = this.readAsset(assetId).then(bytes => URL.createObjectURL(new Blob([bytes.slice().buffer])));
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
