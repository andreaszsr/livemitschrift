import type { PageEdit } from "@livemitschrift/core";
export interface SaveState { pending: number; saving: boolean; error: string | null; }
/** Acknowledged local transaction queue, including erasing and undo operations. */
export class EditQueue {
    private pending: PageEdit[] = [];
    private running: Promise<boolean> | null = null;
    private error: string | null = null;
    constructor(private readonly write: (edit: PageEdit) => Promise<void>, private readonly onState: (state: SaveState) => void) { }
    get state(): SaveState { return { pending: this.pending.length, saving: this.running !== null, error: this.error }; }
    enqueue(edit: PageEdit): void { this.pending.push(structuredClone(edit)); if (!this.error)
        void this.flush();
    else
        this.onState(this.state); }
    flush(): Promise<boolean> {
        if (this.running)
            return this.running;
        this.error = null;
        this.running = Promise.resolve().then(() => this.drain());
        this.onState(this.state);
        return this.running;
    }
    private async drain(): Promise<boolean> {
        try {
            while (this.pending.length) {
                await this.write(this.pending[0]!);
                this.pending.shift();
            }
            return true;
        }
        catch (error) {
            this.error = String(error);
            return false;
        }
        finally {
            this.running = null;
            this.onState(this.state);
        }
    }
}
