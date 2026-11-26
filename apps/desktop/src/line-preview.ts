import { HIGHLIGHTER_OPACITY } from '@livemitschrift/core';
import type { PageSize, Point } from '@livemitschrift/core';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Straight line shown while the pen still rests on the paper, as SVG over the
 * paper in document coordinates (viewBox = page size), so it scales with zoom
 * like ink. Purely visual; the stored stroke is created on pen-up.
 */
export class LinePreview {
    private readonly svg: SVGSVGElement;
    private readonly line: SVGLineElement;

    constructor(paper: HTMLElement, private readonly page: PageSize) {
        this.svg = document.createElementNS(SVG, 'svg');
        this.svg.classList.add('selection-overlay');
        this.svg.setAttribute('aria-hidden', 'true');
        this.svg.setAttribute('preserveAspectRatio', 'none');
        this.line = document.createElementNS(SVG, 'line');
        this.line.setAttribute('stroke-linecap', 'round');
        this.svg.append(this.line);
        this.svg.style.display = 'none';
        paper.append(this.svg);
    }

    show(from: Point, to: Point, color: string, width: number, highlighter: boolean): void {
        this.svg.setAttribute('viewBox', `0 0 ${this.page.width} ${this.page.height}`);
        this.line.setAttribute('stroke', color);
        this.line.setAttribute('stroke-width', String(width));
        this.line.setAttribute('stroke-opacity', highlighter ? String(HIGHLIGHTER_OPACITY) : '1');
        this.line.setAttribute('x1', String(from.x));
        this.line.setAttribute('y1', String(from.y));
        this.move(to);
        this.svg.style.display = '';
    }

    move(to: {x: number; y: number}): void {
        this.line.setAttribute('x2', String(to.x));
        this.line.setAttribute('y2', String(to.y));
    }

    hide(): void { this.svg.style.display = 'none'; }
}
