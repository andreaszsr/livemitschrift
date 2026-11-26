import test from 'node:test';
import assert from 'node:assert/strict';
import { HoldDetector, LINE_HOLD_MS, straightLine } from '../dist/index.js';

const p = (x, y, pressure = .5) => ({x, y, pressure});

test('a stroke that rests at its end is held after the hold time', () => {
  const hold = new HoldDetector();
  hold.begin(p(0, 0), 0);
  assert.equal(hold.move(p(100, 0), 100, 1), true);
  assert.equal(hold.held(100 + LINE_HOLD_MS - 1, 1), null);
  assert.deepEqual(hold.held(100 + LINE_HOLD_MS, 1), p(100, 0));
});

test('small jitter keeps the hold, larger movement restarts it', () => {
  const hold = new HoldDetector();
  hold.begin(p(0, 0), 0);
  hold.move(p(100, 0), 0, 1);
  assert.equal(hold.move(p(103, 2), 200, 1), false);
  assert.equal(hold.remaining(200), LINE_HOLD_MS - 200);
  assert.equal(hold.move(p(120, 0), 300, 1), true);
  assert.equal(hold.held(LINE_HOLD_MS + 100, 1), null);
  assert.deepEqual(hold.held(300 + LINE_HOLD_MS, 1), p(120, 0));
});

test('hold radius and minimum length are measured in screen pixels', () => {
  const hold = new HoldDetector();
  hold.begin(p(0, 0), 0);
  hold.move(p(15, 0), 0, 1);
  // 15 document units at zoom 1 are too short for a line ...
  assert.equal(hold.held(LINE_HOLD_MS, 1), null);
  // ... but long enough at zoom 2.
  assert.deepEqual(hold.held(LINE_HOLD_MS, 2), p(15, 0));
  // At zoom 2, 3 units of jitter are 6 screen pixels and restart the hold.
  assert.equal(hold.move(p(18, 0), 10, 2), true);
});

test('a tap or a stroke without hold is never a line', () => {
  const hold = new HoldDetector();
  hold.begin(p(50, 50), 0);
  assert.equal(hold.held(5000, 1), null);
  hold.reset();
  assert.equal(hold.held(5000, 1), null);
  assert.equal(hold.move(p(500, 500), 5000, 1), false);
});

test('a straight line keeps the start and uses the mean pressure', () => {
  assert.deepEqual(straightLine([p(10, 20, .2), p(40, 60, .6), p(80, 90, 1)], {x: 200, y: 30}),
    [p(10, 20, .6), p(200, 30, .6)]);
  assert.throws(() => straightLine([], {x: 0, y: 0}));
});
