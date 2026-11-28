import { MAX_TEXT_LENGTH, TEXT_FONT_SIZE, TEXT_LINE_HEIGHT, TEXT_SIZES } from '@livemitschrift/core';
import type { PageText, TextSize } from '@livemitschrift/core';

const units = (value: number): string => `calc(100cqw * ${value / 1200})`;
const SIZE_LABELS: Record<TextSize, string> = {small: 'Klein', medium: 'Mittel', large: 'Groß'};

/**
 * Editing one text box: a textarea at the box position with the box's font,
 * size and width, plus a small bar for size, code and "Fertig". While
 * editing, the browser wraps the textarea itself; the stored box is rendered
 * with the shared layout once editing ends.
 */
export class TextEditor {
    private root: HTMLDivElement | null = null;
    private field: HTMLTextAreaElement | null = null;
    private box: PageText | null = null;

    /** `done` is called when editing should end (Esc or "Fertig"). */
    constructor(private readonly paper: HTMLElement, private readonly done: () => void) {}

    get active(): boolean { return this.box !== null; }
    get editing(): PageText | null { return this.box; }

    open(box: PageText): void {
        this.close();
        this.box = {...box};
        const root = document.createElement('div'), field = document.createElement('textarea'), bar = document.createElement('div');
        root.className = 'text-editor';
        field.value = box.text;
        field.maxLength = MAX_TEXT_LENGTH;
        field.spellcheck = false;
        field.title = 'Text eingeben. Links mit https:// werden für Studierende anklickbar. Esc oder „Fertig“ beendet die Eingabe.';
        field.setAttribute('aria-label', 'Text des Textfelds');
        field.addEventListener('input', () => this.fit());
        field.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); this.done(); } });
        bar.className = 'text-options';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Textfeld');
        const sizes = TEXT_SIZES.map(size => this.button(SIZE_LABELS[size], `Schriftgröße ${SIZE_LABELS[size].toLowerCase()}.`, () => this.update({size})));
        const code = this.button('Code', 'Code: Festbreitenschrift, Leerzeichen und Einrückung bleiben erhalten, keine Links.', () => this.update({code: !this.box!.code}));
        const finish = this.button('Fertig', 'Eingabe beenden und das Textfeld speichern.', () => this.done());
        bar.append(...sizes, code, finish);
        // Keep the textarea focused when a bar button is pressed.
        bar.addEventListener('pointerdown', event => event.preventDefault());
        root.append(bar, field);
        this.paper.append(root);
        this.root = root; this.field = field;
        this.apply();
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
    }

    /** End editing and return the box with the typed (not yet normalized) text. */
    close(): PageText | null {
        const box = this.box;
        if (box && this.field) box.text = this.field.value;
        this.root?.remove();
        this.root = null; this.field = null; this.box = null;
        return box;
    }

    private update(change: Partial<PageText>): void {
        if (!this.box) return;
        Object.assign(this.box, change);
        this.apply();
        this.field?.focus();
    }

    private apply(): void {
        const box = this.box, root = this.root, field = this.field;
        if (!box || !root || !field) return;
        root.classList.toggle('code', box.code);
        root.style.left = units(box.x); root.style.top = units(box.y); root.style.width = units(box.width);
        field.style.fontSize = units(TEXT_FONT_SIZE[box.size]);
        field.style.lineHeight = units(TEXT_FONT_SIZE[box.size] * TEXT_LINE_HEIGHT);
        field.style.color = box.color;
        root.querySelectorAll<HTMLButtonElement>('.text-options button').forEach((button, index) => {
            if (index < TEXT_SIZES.length) button.setAttribute('aria-pressed', String(TEXT_SIZES[index] === box.size));
            else if (index === TEXT_SIZES.length) button.setAttribute('aria-pressed', String(box.code));
        });
        this.fit();
    }

    /** Grow the textarea with its content; at least one line high. */
    private fit(): void {
        const field = this.field;
        if (!field) return;
        field.style.height = 'auto';
        field.style.height = `${Math.max(field.scrollHeight, 1)}px`;
    }

    private button(label: string, title: string, run: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = label; button.title = title;
        button.addEventListener('click', run);
        return button;
    }
}
