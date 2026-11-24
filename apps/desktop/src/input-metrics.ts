import type { InputObservation, Point } from '@livemitschrift/core';

interface Distribution { count: number; mean: number | null; median: number | null; p95: number | null; max: number | null }
export interface InputProfile {
  device: string | null;
  events: number;
  points: number;
  strokes: number;
  eventHz: number | null;
  medianHz: number | null;
  eventIntervalsMs: Distribution;
  deliveryMs: Distribution;
  appKitQueueMs: Distribution;
  processingMs: Distribution;
  pointStepsPx: Distribution;
  duplicateTimestamps: number;
  missingSequences: number;
  outOfOrderSequences: number;
  capped: boolean;
  mouseCoalescingEnabled: boolean | null;
  clockWarnings: number;
  focusChanges: number;
}

function distribution(values: number[]): Distribution {
  if (!values.length) return {count: 0, mean: null, median: null, p95: null, max: null};
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {count: values.length, mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: percentile(.5), p95: percentile(.95), max: sorted.at(-1)!};
}

/** Counts only; coordinates never enter the diagnostic report or leave the app. */
export class InputMetrics {
  private recording = false;
  private device: string | null = null;
  private intervals: number[] = [];
  private delivery: number[] = [];
  private queue: number[] = [];
  private processing: number[] = [];
  private steps: number[] = [];
  private events = 0;
  private points = 0;
  private strokes = 0;
  private duplicates = 0;
  private missing = 0;
  private outOfOrder = 0;
  private lastTimestamp: number | null = null;
  private lastSequence: number | null = null;
  private lastPoint: Point | null = null;
  private capped = false;
  private coalescing: boolean | null = null;
  private clockWarnings = 0;
  private focusChanges = 0;

  start(): void {
    this.intervals = []; this.delivery = []; this.queue = []; this.processing = []; this.steps = [];
    this.events = this.points = this.strokes = this.duplicates = this.missing = this.outOfOrder = 0;
    this.device = null; this.lastTimestamp = this.lastSequence = null; this.lastPoint = null;
    this.capped = false; this.coalescing = null; this.recording = true;
    this.clockWarnings = 0;
    this.focusChanges = 0;
  }
  stop(): InputProfile {this.recording = false; return this.snapshot();}
  private add(values: number[], value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    if (values.length < 20_000) values.push(value); else this.capped = true;
  }
  observe(sample: InputObservation, receivedAt = Date.now()): void {
    if (!this.recording) return;
    // Sequence numbers include hover/mouse events: inspect them before filtering
    // so an intentional device/contact filter cannot masquerade as bridge loss.
    if (sample.sequence !== undefined) {
      if (this.lastSequence !== null) {
        if (sample.sequence > this.lastSequence + 1) this.missing += sample.sequence - this.lastSequence - 1;
        if (sample.sequence <= this.lastSequence) this.outOfOrder++;
      }
      this.lastSequence = sample.sequence;
    }
    if (sample.pointerType !== 'pen') return;
    if (!sample.inContact) {this.lastTimestamp = null; return;}
    this.device = sample.source ?? 'pointer'; this.events += sample.sampleCount;
    this.coalescing = sample.mouseCoalescingEnabled ?? null;
    if (sample.timestamp !== undefined) {
      if (this.lastTimestamp !== null) {
        const interval = sample.timestamp - this.lastTimestamp;
        if (interval > 0) this.add(this.intervals, interval); else this.duplicates++;
      }
      this.lastTimestamp = sample.timestamp;
    }
    if (sample.sentAt !== undefined) {
      const delay = receivedAt - sample.sentAt;
      // JS Date.now() rounds wall time to milliseconds, native time does not.
      // Retain sub-ms arrivals as zero rather than biasing towards slow samples.
      if (delay >= -1) this.add(this.delivery, Math.max(0, delay)); else this.clockWarnings++;
    }
    if (sample.queueDelayMs !== undefined) this.add(this.queue, sample.queueDelayMs);
  }
  accept(points: Point[], scale: number, start = false): void {
    if (!this.recording) return;
    if (start) {this.lastPoint = null; this.strokes++;}
    for (const point of points) {
      if (this.lastPoint) this.add(this.steps, Math.hypot(point.x - this.lastPoint.x, point.y - this.lastPoint.y) * scale);
      this.lastPoint = point; this.points++;
    }
  }
  processed(milliseconds: number): void {if (this.recording) this.add(this.processing, milliseconds);}
  focusChanged(): void {if (this.recording) this.focusChanges++;}
  snapshot(): InputProfile {
    const intervals = distribution(this.intervals);
    return {device: this.device, events: this.events, points: this.points, strokes: this.strokes,
      eventHz: intervals.mean ? 1000 / intervals.mean : null, medianHz: intervals.median ? 1000 / intervals.median : null,
      eventIntervalsMs: intervals, deliveryMs: distribution(this.delivery), appKitQueueMs: distribution(this.queue),
      processingMs: distribution(this.processing), pointStepsPx: distribution(this.steps), duplicateTimestamps: this.duplicates,
      missingSequences: this.missing, outOfOrderSequences: this.outOfOrder, capped: this.capped, mouseCoalescingEnabled: this.coalescing, clockWarnings: this.clockWarnings, focusChanges: this.focusChanges};
  }
}
