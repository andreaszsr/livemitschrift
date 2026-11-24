import type {ToolbarDestination} from './toolbar-order.js';

/** Pointer dragging works in WKWebView without native HTML drop interception. */
export function toolbarDrag(dialog: HTMLDialogElement, handle: HTMLButtonElement,
    drop: (destination: ToolbarDestination, before?: string) => void): void {
    handle.addEventListener('pointerdown', start => {
        if (start.button !== 0) return;
        start.preventDefault();
        const listeners = new AbortController(), marker = document.createElement('div');
        marker.className = 'customizer-drop';
        const row = handle.closest<HTMLElement>('.customizer-row')!;
        let active = false, destination: ToolbarDestination | undefined, before: string | undefined;
        const finish = (apply: boolean): void => {
            listeners.abort(); marker.remove(); row.classList.remove('dragging');
            if (apply && active && destination) drop(destination, before);
        };
        const locate = (event: PointerEvent): void => {
            marker.remove(); destination = undefined; before = undefined;
            const zone = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.customizer-zone');
            if (!zone || !dialog.contains(zone)) return;
            destination = zone.dataset.target as ToolbarDestination;
            const next = [...zone.querySelectorAll<HTMLElement>('.customizer-row')]
                .find(item => event.clientY < item.getBoundingClientRect().top + item.offsetHeight / 2);
            before = next?.dataset.id;
            zone.insertBefore(marker, next ?? null);
        };
        document.addEventListener('pointermove', event => {
            if (event.pointerId !== start.pointerId) return;
            if (!(event.buttons & 1)) {finish(false); return;}
            if (!active && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 4) return;
            active = true; event.preventDefault(); row.classList.add('dragging'); locate(event);
        }, {signal: listeners.signal});
        document.addEventListener('pointerup', event => {
            if (event.pointerId !== start.pointerId) return;
            if (active) locate(event);
            finish(true);
        }, {signal: listeners.signal});
        document.addEventListener('pointercancel', () => finish(false), {signal: listeners.signal});
        window.addEventListener('blur', () => finish(false), {signal: listeners.signal});
        dialog.addEventListener('close', () => finish(false), {signal: listeners.signal});
    });
}
