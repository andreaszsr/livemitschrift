import test from 'node:test';
import assert from 'node:assert/strict';
import { clampOffset, lassoSelection, pasteStrokes, pointInPolygon, strokeBounds, translateStrokes } from '../dist/index.js';

const stroke = (id, points, order = 0, extra = {}) => ({id, order, color: '#243147', width: 4, complete: true, points: points.map(([x, y]) => ({x, y, pressure: .5})), ...extra});
const square = [{x: 0, y: 0}, {x: 100, y: 0}, {x: 100, y: 100}, {x: 0, y: 100}];

test('point in polygon handles inside, outside and concave shapes', () => {
  assert.equal(pointInPolygon({x: 50, y: 50}, square), true);
  assert.equal(pointInPolygon({x: 150, y: 50}, square), false);
  const notch = [{x: 0, y: 0}, {x: 100, y: 0}, {x: 100, y: 100}, {x: 50, y: 40}, {x: 0, y: 100}];
  assert.equal(pointInPolygon({x: 50, y: 80}, notch), false);
  assert.equal(pointInPolygon({x: 50, y: 20}, notch), true);
});

test('lasso selects strokes mostly inside and ignores active or barely touching ink', () => {
  const inside = stroke('in', [[10, 10], [20, 20], [30, 30]]);
  const touching = stroke('touch', [[90, 50], [150, 50], [200, 50], [250, 50]]);
  const active = {...stroke('active', [[50, 50]]), complete: false};
  assert.deepEqual(lassoSelection([inside, touching, active], square).map(s => s.id), ['in']);
  assert.deepEqual(lassoSelection([inside], square.slice(0, 2)), []);
});

test('bounds include stroke width; translation keeps identity and styles', () => {
  const marker = stroke('m', [[10, 20], [30, 40]], 3, {highlighter: true});
  assert.deepEqual(strokeBounds([marker]), {left: 8, top: 18, right: 32, bottom: 42});
  assert.equal(strokeBounds([]), null);
  const [moved] = translateStrokes([marker], {x: 5, y: -10});
  assert.deepEqual(moved.points.map(p => [p.x, p.y]), [[15, 10], [35, 30]]);
  assert.equal(moved.id, 'm'); assert.equal(moved.order, 3); assert.equal(moved.highlighter, true);
  assert.deepEqual(marker.points[0], {x: 10, y: 20, pressure: .5}, 'source is not mutated');
});

test('offsets are clamped so all points stay on the page', () => {
  const ink = [stroke('a', [[10, 10], [100, 50]])];
  const page = {width: 1200, height: 1600};
  assert.deepEqual(clampOffset(ink, {x: -50, y: -50}, page), {x: -10, y: -10});
  assert.deepEqual(clampOffset(ink, {x: 5000, y: 5000}, page), {x: 1100, y: 1550});
  assert.deepEqual(clampOffset(ink, {x: 3, y: 4}, page), {x: 3, y: 4});
});

test('pasted strokes get new ids and consecutive orders in their original order', () => {
  let n = 0;
  const pasted = pasteStrokes([stroke('b', [[50, 50]], 9), stroke('a', [[10, 10]], 2)], {x: 20, y: 20}, {width: 1200, height: 1600}, 40, () => `new-${++n}`);
  assert.deepEqual(pasted.map(s => [s.id, s.order, s.points[0].x]), [['new-1', 40, 30], ['new-2', 41, 70]]);
  assert.ok(pasted.every(s => s.complete));
});
