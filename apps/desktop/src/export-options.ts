/**
 * PDF export choices for one topic. Page numbers are 1-based, as in the page
 * counter ("3 / 12"); one notebook page may still span several PDF pages.
 */

/** Parse a page list such as "2-5, 7" into sorted unique page numbers; null if invalid. */
export function parsePageRange(text: string, count: number): number[] | null {
    const pages = new Set<number>();
    const parts = text.split(',').map(part => part.trim());
    if (!parts.some(part => part)) return null;
    for (const part of parts) {
        if (!part) continue;
        // Accept the hyphen and the en dash that macOS may substitute.
        const match = /^(\d{1,5})(?:\s*[-–]\s*(\d{1,5}))?$/.exec(part);
        if (!match) return null;
        const first = Number(match[1]), last = Number(match[2] ?? match[1]);
        if (first < 1 || last < first || last > count) return null;
        for (let page = first; page <= last; page++) pages.add(page);
    }
    return [...pages].sort((a, b) => a - b);
}

/** Compact form of sorted page numbers: [1, 2, 3, 5] → "1-3,5". */
export function formatPageRange(pages: number[]): string {
    const parts: string[] = [];
    for (let index = 0; index < pages.length; index++) {
        const first = pages[index]!;
        while (index + 1 < pages.length && pages[index + 1] === pages[index]! + 1) index++;
        parts.push(first === pages[index] ? String(first) : `${first}-${pages[index]}`);
    }
    return parts.join(',');
}

/**
 * Pages written since the previous export: from the page after the last
 * exported one up to the visible page. If the visible page was already
 * exported, offer just that page.
 */
export function defaultExportRange(lastExported: number | null, current: number): string {
    const first = lastExported === null ? 1 : lastExported < current ? lastExported + 1 : current;
    return formatPageRange(Array.from({length: current - first + 1}, (_, index) => first + index));
}

/** Characters that are invalid or awkward in macOS, Windows or Nextcloud file names. */
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]/;

function namePart(text: string): string {
    return text.replace(new RegExp(UNSAFE, 'g'), '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
}

/**
 * Default file name (without ".pdf"): YYYY-MM-DD_topic_notebook in local time.
 * The date comes first so exports sort chronologically in a folder.
 */
export function exportFileName(notebook: string, topic: string, date: Date): string {
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return [...`${day}_${namePart(topic) || 'Thema'}_${namePart(notebook) || 'Notizbuch'}`].slice(0, 200).join('');
}

/** A user-entered file name without ".pdf", or null if it cannot be used as is. */
export function validExportFileName(text: string): string | null {
    const name = text.trim().replace(/\.pdf$/i, '').trim();
    return !name || [...name].length > 200 || name.startsWith('.') || UNSAFE.test(name) ? null : name;
}
