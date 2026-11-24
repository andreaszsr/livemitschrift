import type { DrawingChange, InkDocument } from "./document.js";
import type { Operation, Point, Stroke } from "./protocol.js";

export function createStrokeId(): string {
  return crypto.randomUUID?.() ?? crypto.getRandomValues(new Uint32Array(4)).join("-");
}

/** Local drawing state. Rendering and optional persistence/sync subscribe after apply. */
export class DrawingSession {
  private activeStroke: string | null = null;

  constructor(
    readonly document: InkDocument,
    private readonly onChange: (change: DrawingChange | null, operation: Operation) => void,
    private readonly nextId: () => string = createStrokeId,
    private readonly style: () => Pick<Stroke, "color" | "width" | "order" | "highlighter"> = () => ({ color: "#243147", width: 3.5 }),
  ) {}

  start(point: Point): void {
    if (this.activeStroke !== null) throw new Error("Finish the active stroke first.");
    const id = this.nextId();
    this.apply({ type: "stroke_start", stroke: {
      id, ...this.style(), points: [point], complete: false,
    } });
    this.activeStroke = id;
  }

  append(points: Point[]): void {
    if (this.activeStroke === null || points.length === 0) return;
    this.apply({ type: "stroke_points", stroke_id: this.activeStroke, points });
  }

  finish(): void {
    if (this.activeStroke === null) return;
    this.apply({ type: "stroke_end", stroke_id: this.activeStroke });
    this.activeStroke = null;
  }

  private apply(operation: Operation): void {
    const change = this.document.apply(operation);
    this.onChange(change, operation);
  }
}
