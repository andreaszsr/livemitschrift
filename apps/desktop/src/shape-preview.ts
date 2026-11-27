import type { PageSize, Point } from '@livemitschrift/core';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Shape shown while it is being dragged, as one SVG path over the paper in
 * document coordinates (viewBox = page size), so it scales with zoom like
 * ink. Purely visual; the strokes are created on pen-up.
 */
export class ShapePreview {
    private readonly svg: SVGSVGElement;
    private readonly path: SVGPathElement;

    constructor(paper: HTMLElement, private readonly page: PageSize) {
        this.svg = document.createElementNS(SVG, 'svg');
        this.svg.classList.add('selection-overlay', 'shape-preview');
        this.svg.setAttribute('aria-hidden', 'true');
        this.svg.setAttribute('preserveAspectRatio', 'none');
        this.path = document.createElementNS(SVG, 'path');
        this.path.setAttribute('fill', 'none');
        this.path.setAttribute('stroke-linecap', 'round');
        this.path.setAttribute('stroke-linejoin', 'round');
        this.svg.append(this.path);
        this.svg.style.display = 'none';
        paper.append(this.svg);
    }

    show(strokes: Point[][], color: string, width: number): void {
        this.svg.setAttribute('viewBox', `0 0 ${this.page.width} ${this.page.height}`);
        this.path.setAttribute('stroke', color);
        this.path.setAttribute('stroke-width', String(width));
        this.path.setAttribute('d', strokes.map(points => points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join('')).join(''));
        this.svg.style.display = '';
    }

    hide(): void { this.svg.style.display = 'none'; }
}
