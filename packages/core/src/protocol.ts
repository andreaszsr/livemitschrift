export interface Point {
  x: number;
  y: number;
  pressure: number;
}

export interface Stroke {
  id: string;
  color: string;
  width: number;
  points: Point[];
  complete: boolean;
  /** Stable drawing order in a notebook page. */
  order?: number;
  /** Semi-transparent marker ink drawn with constant width. Absent for pen ink. */
  highlighter?: true;
}

/** Marker ink opacity shared by canvas rendering and PDF export. */
export const HIGHLIGHTER_OPACITY = 0.35;
export const HIGHLIGHTER_WIDTH = 16;
export const HIGHLIGHTER_COLOR = '#ffd400';

export interface PageSize {
  width: number;
  height: number;
}

export interface PdfBackground {
  assetId: string;
  name: string;
  pageNumber: number;
  width: number;
  height: number;
  /** Optional fixed PDF height limit, independent of growing writing space. */
  fitHeight?: number;
}

export const MAX_PDF_BYTES = 50_000_000;

export type Operation =
  | { type: "stroke_start"; stroke: Stroke }
  | { type: "stroke_points"; stroke_id: string; points: Point[] }
  | { type: "stroke_end"; stroke_id: string };

export interface Snapshot {
  type: "snapshot";
  page: PageSize;
  strokes: Stroke[];
  background?: PdfBackground | null;
}

export type ServerMessage = Snapshot | Operation;
export type Role = "instructor" | "student";
export const PAGE_SIZE: PageSize = { width: 1200, height: 1600 };
export const MAX_BATCH_POINTS = 128;
