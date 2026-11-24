import type { Operation, Snapshot, Stroke } from "./protocol.js";

export interface DrawingChange {
  stroke: Stroke;
  from: number;
}

export class InkDocument {
  readonly strokes = new Map<string, Stroke>();

  replace(snapshot: Snapshot): void {
    this.strokes.clear();
    for (const stroke of snapshot.strokes) {
      this.strokes.set(stroke.id, structuredClone(stroke));
    }
  }

  apply(operation: Operation): DrawingChange | null {
    if (operation.type === "stroke_start") {
      if (this.strokes.has(operation.stroke.id)) {
        throw new Error("Duplicate stroke ID.");
      }
      const stroke = structuredClone(operation.stroke);
      this.strokes.set(stroke.id, stroke);
      return { stroke, from: 0 };
    }

    const stroke = this.strokes.get(operation.stroke_id);
    if (!stroke || stroke.complete) {
      throw new Error("The stroke is not active.");
    }
    if (operation.type === "stroke_end") {
      stroke.complete = true;
      return null;
    }
    const from = stroke.points.length;
    stroke.points.push(...operation.points);
    return { stroke, from };
  }
}
