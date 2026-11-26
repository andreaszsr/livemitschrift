import type { NotePage, Point } from '@livemitschrift/core';
import { linkedText } from '@livemitschrift/ui';
import { MAX_NOTE_LENGTH, noteId, noteText, pageNotes } from './student-notes.js';
import type { NoteStore, StudentNote } from './student-notes.js';

export interface NotesLayerHost {
    /** Map a click in client coordinates to document coordinates of the current page. */
    toPoint(clientX: number, clientY: number): Point;
    /** The shared viewer dialog, emptied and titled. */
    dialog(title: string): HTMLDialogElement;
    /** Notes or the placing mode changed (toolbar state, first-note hint). */
    changed(): void;
    error(message: string): void;
}

/**
 * Numbered note markers over the paper. Markers are positioned in percent of
 * the page size, so zooming scales them with the paper without recomputation;
 * only a page change or a taller page re-renders them. All text is inserted as
 * text nodes (or safe links), never as HTML.
 */
export class NotesLayer {
    private readonly layer: HTMLDivElement;
    private page: NotePage | null = null;
    private placingMode = false;

    constructor(private readonly paper: HTMLElement, private readonly store: NoteStore, private readonly host: NotesLayerHost) {
        this.layer = document.createElement('div');
        this.layer.className = 'notes-layer';
        paper.append(this.layer);
        // A tap without movement fires click; swipes and scrolls do not.
        paper.addEventListener('click', event => {
            if (!this.placingMode || !this.page || (event.target as Element).closest('.note-marker')) return;
            const point = host.toPoint(event.clientX, event.clientY), now = Date.now();
            this.edit({id: noteId(), pageId: this.page.id, x: point.x, y: point.y, text: '', created: now, updated: now}, true);
        });
    }

    get placing(): boolean { return this.placingMode; }

    setPlacing(placing: boolean): void {
        this.placingMode = placing && this.page !== null;
        this.paper.dataset.notes = this.placingMode ? 'placing' : '';
        this.host.changed();
    }

    render(page: NotePage | null): void {
        this.page = page;
        this.layer.replaceChildren();
        if (!page) return;
        for (const {note, number} of pageNotes(this.store.all, page.id)) {
            const marker = document.createElement('button');
            marker.type = 'button';
            marker.className = 'note-marker';
            marker.textContent = String(number);
            marker.style.left = `${note.x / page.width * 100}%`;
            marker.style.top = `${Math.min(note.y, page.height) / page.height * 100}%`;
            marker.setAttribute('aria-label', `Meine Notiz ${number}`);
            marker.title = `Notiz ${number}: ${[...note.text].slice(0, 80).join('')}`;
            marker.addEventListener('click', () => this.show(note, number));
            this.layer.append(marker);
        }
    }

    /** Read view with clickable links, plus edit and delete. */
    show(note: StudentNote, number: number): void {
        const view = this.host.dialog(`Meine Notiz ${number}`), text = document.createElement('p');
        text.className = 'note-text';
        text.append(linkedText(note.text));
        const actions = this.actions(view, [
            ['Löschen', 'Diese Notiz aus diesem Browser löschen.', () => this.remove(view, note)],
            ['Bearbeiten', 'Den Text dieser Notiz ändern.', () => this.edit(note, false)],
        ]);
        view.append(text, actions);
        view.showModal();
    }

    private edit(note: StudentNote, isNew: boolean): void {
        const view = this.host.dialog(isNew ? 'Neue Notiz' : 'Notiz bearbeiten'), form = document.createElement('form');
        const field = document.createElement('textarea'), hint = document.createElement('p');
        field.name = 'note-text'; field.value = note.text; field.rows = 6; field.maxLength = MAX_NOTE_LENGTH; field.required = true;
        field.title = 'Text der Notiz. Links mit https:// werden anklickbar.';
        hint.textContent = 'Nur in diesem Browser gespeichert, nicht auf dem Server.';
        const cancel = document.createElement('button'), submit = document.createElement('button'), actions = document.createElement('div');
        actions.className = 'dialog-actions';
        cancel.type = 'button'; cancel.textContent = 'Abbrechen'; cancel.title = 'Ohne Speichern schließen.';
        cancel.addEventListener('click', () => view.close());
        submit.type = 'submit'; submit.className = 'primary'; submit.textContent = 'Speichern'; submit.title = 'Notiz in diesem Browser speichern.';
        actions.append(cancel, submit);
        form.append(field, hint, actions);
        form.addEventListener('submit', event => {
            event.preventDefault();
            const text = noteText(field.value);
            if (!text) return;
            try {
                this.store.save({...note, text, updated: Math.max(Date.now(), note.updated)});
            } catch (error) {
                this.host.error(`Notiz konnte nicht gespeichert werden: ${String(error)}`);
                return;
            }
            view.close();
            this.placingMode = false;
            this.paper.dataset.notes = '';
            this.render(this.page);
            this.host.changed();
        });
        view.append(form);
        view.showModal();
        field.focus();
    }

    private remove(view: HTMLDialogElement, note: StudentNote): void {
        try { this.store.remove(note.id); } catch (error) { this.host.error(`Notiz konnte nicht gelöscht werden: ${String(error)}`); return; }
        view.close();
        this.render(this.page);
        this.host.changed();
    }

    private actions(view: HTMLDialogElement, items: [string, string, () => void][]): HTMLDivElement {
        const actions = document.createElement('div');
        actions.className = 'dialog-actions';
        const close = document.createElement('button');
        close.type = 'button'; close.textContent = 'Schließen'; close.title = 'Dialog schließen.';
        close.addEventListener('click', () => view.close());
        for (const [label, title, run] of items) {
            const node = document.createElement('button');
            node.type = 'button'; node.textContent = label; node.title = title;
            node.addEventListener('click', run);
            actions.append(node);
        }
        actions.append(close);
        return actions;
    }
}
