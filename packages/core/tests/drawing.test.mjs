import test from "node:test";
import assert from "node:assert/strict";
import { toDocumentPoint, pressureWidth } from "../dist/index.js";
import { InkDocument } from "../dist/index.js";

const page = { width: 1200, height: 1600 };
const point = { x: 100, y: 200, pressure: 0.5 };
const stroke = { id: "test", color: "#243147", width: 3.5, points: [point], complete: false };

test("coordinates account for scrolling, scaling, and canvas offset", () => {
  assert.deepEqual(toDocumentPoint(310, 350, 0.7,
    { left: 10, top: -50, width: 600, height: 800 }, page),
  { x: 600, y: 800, pressure: 0.7 });
});

test("different viewport sizes produce the same document point", () => {
  const small = toDocumentPoint(150, 200, 0.5,
    { left: 0, top: 0, width: 300, height: 400 }, page);
  const large = toDocumentPoint(600, 800, 0.5,
    { left: 0, top: 0, width: 1200, height: 1600 }, page);
  assert.deepEqual(small, large);
});

test("pointer capture outside the page clamps coordinates and pressure", () => {
  assert.deepEqual(toDocumentPoint(-20, 2000, 1.5,
    { left: 0, top: 0, width: 600, height: 800 }, page),
  { x: 0, y: 1600, pressure: 1 });
  assert.throws(() => toDocumentPoint(0, 0, 0.5,
    { left: 0, top: 0, width: 0, height: 0 }, page));
});

test("pressure changes width while retaining a visible light stroke", () => {
  assert.equal(pressureWidth(4, 0), 1.4);
  assert.equal(pressureWidth(4, 1), 4);
  assert.ok(pressureWidth(4, 0.2) < pressureWidth(4, 0.8));
});

test("incremental drawing preserves point order and segment boundary", () => {
  const document = new InkDocument();
  assert.equal(document.apply({ type: "stroke_start", stroke }).from, 0);
  const next = { x: 110, y: 220, pressure: 0.9 };
  const change = document.apply({ type: "stroke_points", stroke_id: "test", points: [next] });
  assert.equal(change.from, 1);
  assert.deepEqual(change.stroke.points, [point, next]);
  assert.equal(document.apply({ type: "stroke_end", stroke_id: "test" }), null);
  assert.equal(document.strokes.get("test").complete, true);
  assert.throws(() => document.apply({ type: "stroke_points", stroke_id: "test", points: [next] }));
});

test("snapshots replace stale local state and keep independent geometry", () => {
  const document = new InkDocument();
  document.apply({ type: "stroke_start", stroke: { ...stroke, id: "local" } });
  const snapshot = { type: "snapshot", page, strokes: [structuredClone(stroke)] };
  document.replace(snapshot);
  assert.equal(document.strokes.has("local"), false);
  document.apply({ type: "stroke_points", stroke_id: "test", points: [point] });
  assert.equal(snapshot.strokes[0].points.length, 1);
  assert.equal(document.strokes.get("test").points.length, 2);
});

test("unknown strokes and duplicate IDs fail instead of corrupting state", () => {
  const document = new InkDocument();
  assert.throws(() => document.apply({ type: "stroke_end", stroke_id: "missing" }));
  document.apply({ type: "stroke_start", stroke });
  assert.throws(() => document.apply({ type: "stroke_start", stroke }));
});
