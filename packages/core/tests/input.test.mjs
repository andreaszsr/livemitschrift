import test from "node:test";
import assert from "node:assert/strict";
import { PenInput } from "../dist/index.js";

class TestCanvas extends EventTarget {
  captured = new Set();
  getBoundingClientRect() { return { left: 10, top: 20, width: 600, height: 800 }; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
}

function setup(observe) {
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  const canvas = new TestCanvas();
  const operations = [];
  const input = new PenInput(canvas, { width: 1200, height: 1600 }, {
    enabled: () => true,
    start: point => operations.push(["start", point]),
    points: points => operations.push(["points", points]),
    end: () => operations.push(["end"]),
    observe,
  });
  function dispatch(type, properties = {}) {
    const event = Object.assign(new Event(type), {
      pointerId: 1, isPrimary: true, pointerType: "pen", button: 0, buttons: 1,
      clientX: 60, clientY: 120, pressure: 0.7, ...properties,
    });
    canvas.dispatchEvent(event);
  }
  return { canvas, input, operations, dispatch };
}

test("pen samples preserve pressure and document coordinates until pen up", () => {
  const { operations, dispatch, canvas } = setup();
  dispatch("pointerdown");
  dispatch("pointermove", { clientX: 110, clientY: 220, pressure: 0.8 });
  dispatch("pointerup", { clientX: 160, clientY: 320, pressure: 0, buttons: 0 });
  assert.deepEqual(operations, [
    ["start", { x: 100, y: 200, pressure: 0.7 }],
    ["points", [{ x: 200, y: 400, pressure: 0.8 }]],
    ["points", [{ x: 300, y: 600, pressure: 0.8 }]],
    ["end"],
  ]);
  assert.equal(canvas.captured.size, 0);
});

test("coalesced pen samples stay ordered", () => {
  const { operations, dispatch } = setup();
  dispatch("pointerdown");
  dispatch("pointermove", {
    getCoalescedEvents: () => [
      { pointerType: "pen", clientX: 70, clientY: 140, pressure: 0.6 },
      { pointerType: "pen", clientX: 80, clientY: 160, pressure: 0.9 },
    ],
  });
  assert.deepEqual(operations[1], ["points", [
    { x: 120, y: 240, pressure: 0.6 },
    { x: 140, y: 280, pressure: 0.9 },
  ]]);
});

test("captured motion with a zero buttons bitmask still belongs to the stroke", () => {
  const { operations, dispatch } = setup();
  dispatch("pointerdown", { buttons: 0 });
  dispatch("pointermove", { clientX: 110, buttons: 0 });
  assert.equal(operations.at(-1)[0], "points");
  dispatch("pointerup", { clientX: 110, buttons: 0 });
  assert.equal(operations.at(-1)[0], "end");
});

for (const type of ["pointercancel", "lostpointercapture"]) {
  test(`${type} ends once and permits a new stroke`, () => {
    const { operations, dispatch } = setup();
    dispatch("pointerdown");
    dispatch(type);
    dispatch("pointerup");
    dispatch("pointerdown");
    assert.deepEqual(operations.map(operation => operation[0]), ["start", "end", "start"]);
  });
}

test("window blur finalizes the active stroke", () => {
  const { operations, dispatch } = setup();
  dispatch("pointerdown");
  window.dispatchEvent(new Event("blur"));
  assert.equal(operations.at(-1)[0], "end");
});

test("touch, secondary pointers, and right clicks do not draw", () => {
  const { operations, dispatch } = setup();
  dispatch("pointerdown", { pointerType: "touch" });
  dispatch("pointerdown", { isPrimary: false });
  dispatch("pointerdown", { button: 2 });
  assert.equal(operations.length, 0);
});

test("diagnostics expose raw mouse pressure while geometry uses the fallback pressure", () => {
  const observations = [];
  const { operations, dispatch } = setup(observation => observations.push(observation));
  dispatch("pointerdown", { pointerType: "mouse", pressure: 0 });
  assert.equal(observations[0].pressure, 0);
  assert.equal(observations[0].pointerType, "mouse");
  assert.equal(operations[0][1].pressure, 0.5);
  assert.equal(observations[0].coalesced, false);
});

test("hardware eraser and barrel-button events are observed without drawing", () => {
  const observations = [];
  const { operations, dispatch } = setup(observation => observations.push(observation));
  dispatch("pointerdown", { button: 5, buttons: 32 });
  dispatch("pointerdown", { button: 2, buttons: 2 });
  assert.equal(operations.length, 0);
  assert.equal(observations[0].eraser, true);
  assert.equal(observations[1].eraser, false);
  assert.equal(observations[1].buttons, 2);
});

test("an empty coalesced batch falls back to the original event", () => {
  const observations = [];
  const { operations, dispatch } = setup(observation => observations.push(observation));
  dispatch("pointerdown");
  dispatch("pointermove", { clientX: 110, getCoalescedEvents: () => [] });
  assert.equal(operations[1][0], "points");
  assert.equal(operations[1][1][0].x, 200);
  assert.equal(observations[1].coalesced, true);
  assert.equal(observations[1].sampleCount, 1);
});
