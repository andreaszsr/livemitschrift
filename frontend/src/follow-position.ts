import type { ViewPosition } from '@livemitschrift/core';

/** Match the instructor's document top using the reader's own scale and inset. */
export function followScrollTop(position: ViewPosition, pageWidth: number,
    paper: {top: number; width: number}, viewportTop: number, scrollTop: number): number {
    if (position.y === 0) return 0;
    // paper.top already includes the current scroll offset. Cancel it before
    // placing the requested document coordinate at the viewport's top edge.
    return scrollTop + paper.top - viewportTop + position.y * paper.width / pageWidth;
}
