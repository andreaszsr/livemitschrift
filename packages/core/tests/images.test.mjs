import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNotebookEvent, EditHistory, imageAt, MAX_PAGE_IMAGES, moveImage, placeImage, resizeImage, validNotebookSnapshot, validPageEdit, validPageImage } from '../dist/index.js';

const asset = 'a'.repeat(64);
const image = (id, extra = {}) => ({id, assetId: asset, x: 100, y: 100, width: 300, height: 200, order: 0, ...extra});
const page = (extra = {}) => ({id: 'p', title: 'Seite 1', width: 1200, height: 1600, background: null, strokes: [], nextOrder: 5, ...extra});
const snapshot = p => ({type: 'notebook', notebook: {id: 'n', title: 'N', topics: [{id: 't', title: 'T', pages: [p]}]}, position: {pageId: 'p', y: 0}});
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('image placements are validated against the page', () => {
  assert.equal(validPageImage(image('i'), 1600), true);
  for (const bad of [image('i', {assetId: 'A'.repeat(64)}), image('i', {x: -1}), image('i', {x: 1000}), image('i', {y: 1500}),
    image('i', {width: 5}), image('i', {order: 1.5}), image('bad id'), {...image('i'), assetId: undefined}])
    assert.equal(validPageImage(bad, 1600), false, JSON.stringify(bad));
});

test('snapshots accept pages with and without images, and reject invalid image lists', () => {
  assert.equal(validNotebookSnapshot(snapshot(page())), true);
  assert.equal(validNotebookSnapshot(snapshot(page({images: [image('a'), image('b', {order: 1})]}))), true);
  assert.equal(validNotebookSnapshot(snapshot(page({images: [image('a'), image('a', {order: 1})]}))), false, 'duplicate id');
  assert.equal(validNotebookSnapshot(snapshot(page({images: [image('a', {order: 5})]}))), false, 'order beyond nextOrder');
  const many = Array.from({length: MAX_PAGE_IMAGES + 1}, (_, index) => image(`i${index}`, {order: 0}));
  assert.equal(validNotebookSnapshot(snapshot(page({images: many}))), false);
});

test('edits carry image changes; stroke-only edits keep their old shape', () => {
  const history = new EditHistory();
  const strokesOnly = history.record('p', 1600, [], []);
  assert.deepEqual(Object.keys(strokesOnly).sort(), ['height', 'id', 'insert', 'pageId', 'remove']);
  const inserted = history.record('p', 1600, [], [], {insert: [image('i')], removed: []});
  assert.equal(validPageEdit(inserted), true);
  assert.deepEqual(inserted.insertImages, [image('i')]);
  assert.deepEqual(inserted.removeImages, []);
  assert.equal(validPageEdit({...inserted, insertImages: [image('i'), image('i')]}), false);
  assert.equal(validPageEdit({...inserted, insertImages: [image('i', {y: 1590})]}), false, 'below the edit height');
});

test('applying edits inserts, moves (remove + insert) and removes images; undo restores them', () => {
  const notebook = snapshot(page()).notebook, history = new EditHistory();
  const apply = edit => applyNotebookEvent(notebook, {type: 'edit', edit});
  const target = () => notebook.topics[0].pages[0];
  apply(history.record('p', 1600, [], [], {insert: [image('i', {order: 7})], removed: []}));
  assert.deepEqual(target().images, [image('i', {order: 7})]);
  assert.equal(target().nextOrder, 8);
  const moved = image('i', {order: 7, x: 500});
  apply(history.record('p', 1600, [], [], {insert: [moved], removed: [target().images[0]]}));
  assert.equal(target().images[0].x, 500);
  apply(history.undo());
  assert.equal(target().images[0].x, 100);
  apply(history.record('p', 1600, [], [], {insert: [], removed: [target().images[0]]}));
  assert.deepEqual(target().images, []);
  assert.throws(() => { apply(history.record('p', 1600, [], [], {insert: [image('j')], removed: []})); apply(history.record('p', 1600, [], [], {insert: [image('j')], removed: []})); }, /Conflicting image/);
});

test('placement fits the visible area without upscaling', () => {
  const small = placeImage(200, 100, 3000, 800);
  assert.deepEqual(small, {x: 500, y: 3350, width: 200, height: 100});
  const big = placeImage(4000, 1000, 0, 800);
  assert.ok(near(big.width, 720) && near(big.height, 180) && near(big.x, 240));
  const tall = placeImage(1000, 4000, 0, 1000);
  assert.ok(near(tall.height, 600) && near(tall.width, 150));
});

test('moving stays inside the page width and below the top', () => {
  assert.deepEqual(moveImage(image('i'), -500, -500), image('i', {x: 0, y: 0}));
  assert.equal(moveImage(image('i'), 2000, 0).x, 900);
});

test('resizing keeps the aspect ratio and the opposite corner', () => {
  const grown = resizeImage(image('i'), 'se', {x: 700, y: 120});
  assert.ok(near(grown.width, 600) && near(grown.height, 400) && grown.x === 100 && grown.y === 100);
  const fromTopLeft = resizeImage(image('i'), 'nw', {x: 250, y: 0});
  assert.ok(near(fromTopLeft.x + fromTopLeft.width, 400) && near(fromTopLeft.y + fromTopLeft.height, 300));
  assert.ok(near(fromTopLeft.width / fromTopLeft.height, 1.5));
  const clamped = resizeImage(image('i'), 'se', {x: 5000, y: 120});
  assert.ok(near(clamped.x + clamped.width, 1200));
  const tiny = resizeImage(image('i'), 'se', {x: 100, y: 100});
  assert.ok(tiny.width >= 12 && tiny.height >= 12);
  const top = resizeImage(image('i'), 'ne', {x: 2000, y: -500});
  assert.ok(near(top.y, 0) && top.y >= 0);
});

test('the topmost image under a point is found', () => {
  const images = [image('low', {order: 1}), image('high', {order: 3, x: 200}), image('other', {order: 2, x: 800})];
  assert.equal(imageAt(images, {x: 250, y: 150}).id, 'high');
  assert.equal(imageAt(images, {x: 150, y: 150}).id, 'low');
  assert.equal(imageAt(images, {x: 50, y: 50}), null);
});
