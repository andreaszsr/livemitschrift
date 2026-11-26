/**
 * Plain text split into text and safe links. Only https: and mailto: become
 * links; everything else stays text. Callers create nodes with textContent,
 * so user text is never parsed as HTML.
 */
export interface TextPart { text: string; href?: string }

const LINK = /\bhttps:\/\/[^\s<>"]+|\bmailto:[^\s<>"@]+@[^\s<>"]+/gi;

export function linkParts(text: string): TextPart[] {
    const parts: TextPart[] = [];
    let last = 0;
    for (const match of text.matchAll(LINK)) {
        // Sentence punctuation directly after a URL is not part of it.
        const raw = match[0].replace(/[.,;:!?)\]]+$/, ''), start = match.index;
        let href: string | null = null;
        try { const url = new URL(raw); href = url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null; } catch { href = null; }
        if (!href) continue;
        if (start > last) parts.push({text: text.slice(last, start)});
        parts.push({text: raw, href});
        last = start + raw.length;
    }
    if (last < text.length) parts.push({text: text.slice(last)});
    return parts;
}

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
