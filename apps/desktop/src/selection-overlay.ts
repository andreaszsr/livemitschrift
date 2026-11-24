import type { Bounds, PageSize, Vector } from '@livemitschrift/core';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Lasso path and selection frame as SVG over the paper, in document
 * coordinates (viewBox = page size). Lines keep a constant screen width at any
 * zoom via `vector-effect: non-scaling-stroke`. Purely visual; never stored.
 */
export class SelectionOverlay {
    private readonly svg: SVGSVGElement;
    private readonly path: SVGPolylineElement;
    private readonly frame: SVGRectElement;
    private frameRequest: number | null = null;
    private pending: Vector[] = [];

    constructor(paper: HTMLElement, private readonly page: PageSize) {
        this.svg = document.createElementNS(SVG, 'svg');
        this.svg.classList.add('selection-overlay');
        this.svg.setAttribute('aria-hidden', 'true');
        this.svg.setAttribute('preserveAspectRatio', 'none');
        this.path = document.createElementNS(SVG, 'polyline');
        this.frame = document.createElementNS(SVG, 'rect');
        for (const shape of [this.path, this.frame]) {
            shape.setAttribute('fill', 'none');
            shape.setAttribute('stroke', '#397566');
            shape.setAttribute('stroke-width', '1.5');
            shape.setAttribute('stroke-dasharray', '6 4');
            shape.setAttribute('vector-effect', 'non-scaling-stroke');
        }
        this.frame.setAttribute('fill', '#39756610');
        this.svg.append(this.path, this.frame);
        this.svg.style.display = 'none';
        paper.append(this.svg);
    }

    /** Lasso outline while drawing; updates are batched per animation frame. */
    lasso(points: Vector[]): void {
        this.pending = points;
        if (this.frameRequest === null) this.frameRequest = requestAnimationFrame(() => {
            this.frameRequest = null;
            this.show();
            this.path.setAttribute('points', this.pending.map(point => `${point.x},${point.y}`).join(' '));
        });
    }

    /** Frame around the selection, padded so it does not touch the ink. */
    select(bounds: Bounds | null): void {
        this.path.removeAttribute('points');
        if (!bounds) { this.clear(); return; }
        this.show();
        const pad = 6;
        this.frame.setAttribute('x', String(bounds.left - pad));
        this.frame.setAttribute('y', String(bounds.top - pad));
        this.frame.setAttribute('width', String(bounds.right - bounds.left + 2 * pad));
        this.frame.setAttribute('height', String(bounds.bottom - bounds.top + 2 * pad));
        this.frame.style.display = '';
    }

    clear(): void {
        if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
        this.frameRequest = null;
        this.path.removeAttribute('points');
        this.frame.style.display = 'none';
        this.svg.style.display = 'none';
    }

    private show(): void {
        this.svg.setAttribute('viewBox', `0 0 ${this.page.width} ${this.page.height}`);
        this.svg.style.display = '';
    }
}
