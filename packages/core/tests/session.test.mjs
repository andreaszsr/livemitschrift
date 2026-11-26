import test from "node:test";
import assert from "node:assert/strict";
import { DrawingSession, InkDocument } from "../dist/index.js";

const point = { x: 100, y: 200, pressure: 0.3 };

test("local editing works without a WebSocket and observers see already applied state", () => {
  globalThis.WebSocket = class { constructor() { throw new Error("Network must not be used"); } };
  const document = new InkDocument();
  const received = [];
  const session = new DrawingSession(document, (change, operation) => {
    if (operation.type === "stroke_start") assert.equal(document.strokes.size, 1);
    if (operation.type === "stroke_points") assert.equal(change.stroke.points.length, 2);
    if (operation.type === "stroke_end") assert.equal(document.strokes.get("local-1").complete, true);
    received.push(operation.type);
  }, () => "local-1");
  session.start(point);
  session.append([{ x: 140, y: 220, pressure: 0.8 }]);
  session.finish();
  assert.deepEqual(received, ["stroke_start", "stroke_points", "stroke_end"]);
  assert.equal(document.strokes.get("local-1").points[1].pressure, 0.8);
});

test("interrupted sessions finish once and allow a new independent stroke", () => {
  let sequence = 0;
  const document = new InkDocument();
  const operations = [];
  const session = new DrawingSession(document, (_, operation) => operations.push(operation),
    () => `local-${++sequence}`);
  session.append([point]);
  session.finish();
  session.start(point);
  session.finish();
  session.finish();
  session.start(point);
  session.append([]);
  session.finish();
  assert.equal(document.strokes.size, 2);
  assert.equal(operations.length, 4);
  assert.ok([...document.strokes.values()].every(stroke => stroke.complete));
});

test("starting a second active stroke fails without replacing the first", () => {
  const document = new InkDocument();
  const session = new DrawingSession(document, () => {}, () => "local-1");
  session.start(point);
  assert.throws(() => session.start(point), /Finish the active stroke/);
  assert.equal(document.strokes.size, 1);
  session.append([{ ...point, x: 110 }]);
  session.finish();
  assert.equal(document.strokes.get("local-1").points.length, 2);
});

test("a discarded stroke leaves the document without a stroke_end and allows a new stroke", () => {
  let sequence = 0;
  const document = new InkDocument();
  const operations = [];
  const session = new DrawingSession(document, (_, operation) => operations.push(operation.type),
    () => `local-${++sequence}`);
  assert.equal(session.discard(), null);
  session.start(point);
  session.append([{ x: 150, y: 210, pressure: 0.4 }]);
  const dropped = session.discard();
  assert.equal(dropped.id, "local-1");
  assert.equal(dropped.points.length, 2);
  assert.equal(document.strokes.size, 0);
  session.finish();
  session.start(point);
  session.finish();
  assert.deepEqual(operations, ["stroke_start", "stroke_points", "stroke_start", "stroke_end"]);
  assert.equal(document.strokes.get("local-2").complete, true);
});
