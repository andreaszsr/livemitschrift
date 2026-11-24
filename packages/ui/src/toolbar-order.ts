export type ToolbarDestination = 'toolbar' | 'menu';

/** Move one action without changing the caller's saved preference array. */
export function movePinnedAction(pinned: string[], id: string, destination: ToolbarDestination, before?: string): string[] {
    if (before === id) return [...pinned];
    const next = pinned.filter(key => key !== id);
    if (destination === 'toolbar') {
        const index = before ? next.indexOf(before) : -1;
        next.splice(index < 0 ? next.length : index, 0, id);
    }
    return next;
}
