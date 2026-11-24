import test from "node:test";
import assert from "node:assert/strict";
import { NativePenInput, nativeInputAvailable } from "../.test-build/native-input.js";

function setup(temporaryTool = false) {
  globalThis.window = new EventTarget();
  globalThis.document = new EventTarget();
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, right: 610, bottom: 820, width: 600, height: 800 });
  const viewport = { getBoundingClientRect: () => ({ left: 0, top: 100, right: 800, bottom: 600 }) };
  const operations = [];
  const observations = [];
  const input = new NativePenInput(canvas, viewport, { width: 1200, height: 1600 }, {
    enabled: () => true,
    start: point => operations.push(["start", point]),
    points: points => operations.push(["points", points]),
    end: () => operations.push(["end"]),
    observe: sample => observations.push(sample),
    ...(temporaryTool ? {temporaryTool: tool => operations.push(['tool', tool])} : {}),
  });
  const send = (properties = {}) => input.accept({
    phase: "move", pointerType: "pen", x: 60, y: 120, pressure: 0.02,
    buttons: 0, button: -1, eraser: false, ...properties,
  });
  return { input, canvas, operations, observations, send };
}

test("light tablet contact starts with real pressure before any mouse-down", () => {
  const { send, operations, observations } = setup();
  send();
  send({ x: 110, pressure: 0.18 });
  assert.deepEqual(operations, [
    ["start", { x: 100, y: 200, pressure: 0.02 }],
    ["points", [{ x: 200, y: 200, pressure: 0.18 }]],
  ]);
  assert.equal(observations[0].source, "appkit");
  assert.equal(observations[0].pointerType, "pen");
});

test("driver mouse-up threshold does not cut off a still-touching stylus", () => {
  const { send, operations } = setup();
  send({ phase: "down", pressure: 0.7, buttons: 1, button: 0 });
  send({ phase: "up", pressure: 0.2, x: 80, button: 0 });
  assert.equal(operations.at(-1)[0], "points");
  send({ pressure: 0, x: 90 });
  assert.equal(operations.at(-1)[0], "end");
  assert.equal(operations.at(-2)[1][0].pressure, 0.2);
});

test("pressure-only samples at the same position retain changing pen width", () => {
  const { send, operations } = setup();
  send();
  send({ pressure: 0.9 });
  assert.equal(operations[1][1][0].pressure, 0.9);
  assert.equal(operations[1][1][0].x, operations[0][1].x);
});

test("native mode ignores duplicate DOM mouse emulation", () => {
  const { canvas, send, operations } = setup();
  assert.equal(nativeInputAvailable(), false);
  window.__LIVEMITSCHRIFT_NATIVE_INPUT__ = true;
  assert.equal(nativeInputAvailable(), true);
  send();
  canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerType: "mouse" }));
  assert.equal(operations.length, 1);
});

test("toolbar contact cannot turn into an accidental canvas stroke", () => {
  const { send, operations } = setup();
  send({ y: 40 });
  send({ y: 120 });
  assert.equal(operations.length, 0);
  send({ pressure: 0 });
  send();
  assert.equal(operations[0][0], "start");
});

test("focus/zoom interruption waits for release before the next pen stroke", () => {
  const { send, input, operations } = setup();
  send();
  input.finish();
  send({ pressure: 0.3 });
  assert.deepEqual(operations.map(operation => operation[0]), ["start", "end"]);
  send({ pressure: 0 });
  send();
  assert.equal(operations.at(-1)[0], "start");
});

test("leaving tablet proximity ends ink without drawing toward the origin", () => {
  const { send, operations } = setup();
  send();
  send({ phase: "leave", pressure: 0, x: 0, y: 0 });
  assert.deepEqual(operations.map(operation => operation[0]), ["start", "end"]);
});

test("eraser and secondary-button tablet events do not draw ordinary ink", () => {
  const { send, operations, observations } = setup();
  send({ eraser: true, pressure: 0.8 });
  send({ buttons: 2, button: 1 });
  assert.equal(operations.length, 0);
  assert.equal(observations[0].eraser, true);
});

test("real mouse drag remains supported with the documented fallback pressure", () => {
  const { send, operations } = setup();
  send({ pointerType: "mouse", phase: "down", pressure: 1, buttons: 1, button: 0 });
  send({ pointerType: "mouse", phase: "drag", pressure: 1, x: 110 });
  send({ pointerType: "mouse", phase: "up", pressure: 0 });
  assert.equal(operations[0][1].pressure, 0.5);
  assert.equal(operations[1][1][0].pressure, 0.5);
  assert.equal(operations.at(-1)[0], "end");
});

test("mouse motion cannot append points to an active tablet stroke", () => {
  const { send, operations } = setup();
  send();
  send({ pointerType: "mouse", phase: "move", x: 400, pressure: 0 });
  assert.equal(operations.length, 1);
  send({ x: 70 });
  assert.equal(operations[1][1][0].x, 120);
});

test("invalid native data ends the active stroke and never enters the document", () => {
  const { send, operations } = setup();
  send();
  assert.throws(() => send({ x: NaN }), /Invalid native tablet sample/);
  assert.deepEqual(operations.map(operation => operation[0]), ["start", "end"]);
});

test('native timing reaches diagnostics without changing saved drawing geometry', () => {
  const {send, observations, operations} = setup();
  send({timestamp: 100, sequence: 7, sentAt: 200, queueDelayMs: .4, mouseCoalescingEnabled: false});
  assert.equal(observations[0].timestamp, 100); assert.equal(observations[0].sequence, 7);
  assert.equal(observations[0].mouseCoalescingEnabled, false);
  assert.deepEqual(Object.keys(operations[0][1]).sort(), ['pressure', 'x', 'y']);
  assert.throws(() => send({sequence: 1.5}), /Invalid native tablet sample/);
});

test('lower pen button selects eraser during hover, without creating ink until contact', () => {
  const {send, operations} = setup(true);
  send({buttons: 2, pressure: 0}); assert.deepEqual(operations, [['tool', 'eraser']]);
  send({buttons: 3, pressure: .1}); assert.equal(operations.at(-1)[0], 'start');
  send({buttons: 2, pressure: 0}); assert.equal(operations.at(-1)[0], 'end');
  send({buttons: 0, pressure: 0}); assert.deepEqual(operations.at(-1), ['tool', null]);
});

test('press and release during contact split tool gestures without connecting their paths', () => {
  const {send, operations} = setup(true);
  send({x: 60}); send({x: 70});
  send({buttons: 3, pressure: .2, x: 90});
  send({buttons: 1, pressure: .2, x: 110});
  assert.deepEqual(operations.map(value => value[0]), ['start', 'points', 'end', 'tool', 'start', 'end', 'tool', 'start']);
  assert.deepEqual(operations[3], ['tool', 'eraser']); assert.deepEqual(operations[6], ['tool', null]);
  assert.equal(operations[4][1].x, 160); assert.equal(operations[7][1].x, 200);
});

test('upper pen button and ordinary right mouse clicks do not activate temporary erasing', () => {
  const {send, operations} = setup(true);
  send({buttons: 4, pressure: .5});
  send({pointerType: 'mouse', phase: 'down', button: 1, buttons: 2});
  assert.deepEqual(operations, []);
});

test('focus interruption and proximity exit clear temporary tool and wait for release', () => {
  const {send, input, operations} = setup(true);
  send({buttons: 3}); input.finish();
  assert.deepEqual(operations.at(-1), ['tool', null]); const count = operations.length;
  send({buttons: 3, x: 80}); assert.equal(operations.length, count);
  send({buttons: 2, pressure: 0}); send({buttons: 3, x: 90});
  assert.equal(operations.at(-1)[0], 'start');
  send({phase: 'leave', pressure: 0, buttons: 0, x: 0, y: 0});
  assert.deepEqual(operations.at(-1), ['tool', null]);
});

test('driver erase mode uses the same temporary tool without converting it into pen ink', () => {
  const {send, operations} = setup(true);
  send({eraser: true, pressure: 0, buttons: 0});
  send({eraser: true, pressure: .4, buttons: 1});
  assert.deepEqual(operations[0], ['tool', 'eraser']); assert.equal(operations[1][0], 'start');
  send({eraser: true, pressure: 0, buttons: 0});
  send({eraser: false, pressure: 0, buttons: 0});
  assert.deepEqual(operations.at(-1), ['tool', null]);
});

test('Wacom driver erase mode stays active when the lower-button mask disappears during drag', () => {
  const {send, operations} = setup(true);
  send({eraser: true, pressure: 0, buttons: 0});
  send({eraser: true, pressure: .133, buttons: 3, x: 60});
  send({eraser: true, pressure: .271, buttons: 1, x: 70});
  assert.deepEqual(operations.filter(value => value[0] === 'tool'), [['tool', 'eraser']]);
  send({eraser: true, pressure: 0, buttons: 2, x: 70});
  send({eraser: true, pressure: 0, buttons: 0, x: 70});
  send({eraser: false, pressure: 0, buttons: 0, x: 70});
  assert.deepEqual(operations.map(value => value[0]), ['tool', 'start', 'points', 'end', 'tool']);
  assert.deepEqual(operations.at(-1), ['tool', null]);
});
