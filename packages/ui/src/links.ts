import { linkParts } from '@livemitschrift/core';
export { linkParts } from '@livemitschrift/core';
export type { TextPart } from '@livemitschrift/core';

/** DOM nodes for `linkParts`; links open in a new tab without referrer. */
export function linkedText(text: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    for (const part of linkParts(text)) {
        if (!part.href) { fragment.append(part.text); continue; }
        const link = document.createElement('a');
        link.href = part.href; link.textContent = part.text; link.title = `${part.href} in einem neuen Tab öffnen.`;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        fragment.append(link);
    }
    return fragment;
}
