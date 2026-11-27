/**
 * The page last shown per notebook and per topic, so switching notebooks or
 * opening a topic continues there instead of on page 1. A local preference;
 * scroll positions per page are stored separately.
 */
export interface LastPages { notebooks: Record<string, string>; topics: Record<string, string> }

export const LAST_PAGES_KEY = 'last-pages';
/** Bound the stored maps; entries of deleted notebooks and topics age out. */
const MAX_ENTRIES = 500;

export function parseLastPages(text: string | undefined): LastPages {
    const result: LastPages = {notebooks: {}, topics: {}};
    let value: unknown;
    try { value = text ? JSON.parse(text) : null; } catch { return result; }
    if (!value || typeof value !== 'object') return result;
    for (const scope of ['notebooks', 'topics'] as const) {
        const entries = (value as Record<string, unknown>)[scope];
        if (!entries || typeof entries !== 'object') continue;
        for (const [id, page] of Object.entries(entries)) if (typeof page === 'string') result[scope][id] = page;
    }
    return result;
}

/** Remember a page as the latest of its notebook and topic (most recent last). */
export function rememberPage(pages: LastPages, notebookId: string, topicId: string, pageId: string): LastPages {
    const bump = (entries: Record<string, string>, id: string): Record<string, string> => {
        const next = Object.entries(entries).filter(([key]) => key !== id);
        next.push([id, pageId]);
        return Object.fromEntries(next.slice(-MAX_ENTRIES));
    };
    return {notebooks: bump(pages.notebooks, notebookId), topics: bump(pages.topics, topicId)};
}

/** The remembered page if it still exists among `pages`, else the first page. */
export function resumePage<T extends {id: string}>(pages: T[], remembered: string | undefined): T | undefined {
    return pages.find(page => page.id === remembered) ?? pages[0];
}
