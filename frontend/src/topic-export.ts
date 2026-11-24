import {MAX_NOTEBOOK_POINTS, validSyncPage} from '@livemitschrift/core';
import type {NotePage, Topic} from '@livemitschrift/core';

/** Export confirmed pages separately; never change the live subscription/cache. */
export async function loadExportTopic(topic: Topic, readPage: (id: string) => Promise<unknown>,
    signal: AbortSignal, progress: (loaded: number, total: number) => void): Promise<Topic> {
    const pages: NotePage[] = [];
    let points = 0;
    for (const reference of topic.pages) {
        signal.throwIfAborted();
        progress(pages.length, topic.pages.length);
        const page = await readPage(reference.id);
        signal.throwIfAborted();
        if (!validSyncPage(page) || page.id !== reference.id || page.strokes.some(stroke => !stroke.complete))
            throw new Error('Ungültiger oder unvollständiger Seitenstand. Bitte den Export erneut starten.');
        points += page.strokes.reduce((total, stroke) => total + stroke.points.length, 0);
        if (points > MAX_NOTEBOOK_POINTS) throw new Error('Das Thema ist für einen Browser-PDF-Export zu groß. Bitte den Dozenten um einen Export bitten.');
        pages.push(page);
    }
    progress(pages.length, topic.pages.length);
    return {id: topic.id, title: topic.title, pages};
}

export function exportFilename(title: string): string {
    const name = title.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120);
    return `${name || 'Mitschrift'}.pdf`;
}
