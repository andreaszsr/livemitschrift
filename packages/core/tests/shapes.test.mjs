import test from 'node:test';
import assert from 'node:assert/strict';
import { SHAPE_PRESSURE, shapeStrokes, snapToGrid } from '../dist/index.js';

const xy = points => points.map(({x, y}) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('a rectangle is one closed polyline with sharp corners and uniform pressure', () => {
  const [stroke, ...rest] = shapeStrokes('rectangle', {x: 10, y: 20}, {x: 110, y: 70}, {tickSpacing: 0});
  assert.equal(rest.length, 0);
  assert.deepEqual(xy(stroke), [[10, 20], [110, 20], [110, 70], [10, 70], [10, 20]]);
  assert.ok(stroke.every(point => point.pressure === SHAPE_PRESSURE));
});

test('a circle is centred on the start and its radius is the drag distance', () => {
  const [stroke] = shapeStrokes('circle', {x: 300, y: 300}, {x: 300, y: 400}, {tickSpacing: 0});
  assert.ok(stroke.length > 24);
  assert.ok(stroke.every(point => near(Math.hypot(point.x - 300, point.y - 300), 100)));
  assert.deepEqual(xy([stroke[0]]), xy([stroke.at(-1)]));
  assert.deepEqual(shapeStrokes('circle', {x: 1, y: 1}, {x: 1, y: 1}, {tickSpacing: 0}), []);
});

test('snapping puts corners, centre and radius on the grid', () => {
  assert.deepEqual(snapToGrid({x: 14, y: 26}, 10), {x: 10, y: 30});
  const [rectangle] = shapeStrokes('rectangle', {x: 14, y: 26}, {x: 57, y: 61}, {tickSpacing: 10, snap: 10});
  assert.deepEqual(xy(rectangle), [[10, 30], [60, 30], [60, 60], [10, 60], [10, 30]]);
  const [circle] = shapeStrokes('circle', {x: 103, y: 98}, {x: 103, y: 141}, {tickSpacing: 10, snap: 10});
  assert.ok(circle.every(point => near(Math.hypot(point.x - 100, point.y - 100), 40)));
});

test('quadrant axes start at the origin, point towards the drag end and carry ticks', () => {
  const [x, y] = shapeStrokes('quadrant', {x: 100, y: 500}, {x: 200, y: 400}, {tickSpacing: 25});
  assert.deepEqual(xy([x[0], y[0]]), [[100, 500], [100, 500]]);
  // x-axis: ticks every 25 units up to the 16-unit arrow head, then the tip.
  const onAxis = x.filter(point => near(point.y, 500)).map(point => Math.round(point.x));
  assert.deepEqual([...new Set(onAxis)], [100, 125, 150, 175, 200]);
  const [short] = shapeStrokes('quadrant', {x: 100, y: 500}, {x: 190, y: 400}, {tickSpacing: 25});
  assert.ok(!short.some(point => near(point.x, 175)), 'no tick under the arrow head');
  assert.ok(x.some(point => near(point.x, 125) && near(point.y, 494)), 'tick crosses the axis');
  // y-axis points up (towards smaller y) and ends with its arrow head at the tip.
  assert.ok(y.some(point => near(point.x, 100) && near(point.y, 400)));
  assert.ok(y.every(point => point.y >= 400 - 1e-9 && point.y <= 500 + 1e-9));
  // Dragging left and down flips the axis directions.
  const [left] = shapeStrokes('quadrant', {x: 100, y: 500}, {x: 20, y: 600}, {tickSpacing: 0});
  assert.ok(left.some(point => near(point.x, 20) && near(point.y, 500)));
});

test('a cross has both axes through the centre of the dragged box, ticks from the centre', () => {
  const [x, y] = shapeStrokes('cross', {x: 0, y: 0}, {x: 200, y: 100}, {tickSpacing: 20, snap: 10});
  assert.deepEqual(xy([x[0]]), [[0, 50]]);
  assert.ok(x.some(point => near(point.x, 200) && near(point.y, 50)));
  assert.deepEqual(xy([y[0]]), [[100, 100]]);
  assert.ok(y.some(point => near(point.x, 100) && near(point.y, 0)), 'the vertical axis points up');
  const ticks = [...new Set(x.filter(point => !near(point.y, 50)).map(point => Math.round(point.x)))];
  assert.ok(ticks.includes(20) && ticks.includes(80) && ticks.includes(120) && !ticks.includes(100), String(ticks));
});
