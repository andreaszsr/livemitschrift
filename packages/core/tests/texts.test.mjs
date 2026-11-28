import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNotebookEvent, EditHistory, MAX_PAGE_TEXTS, MAX_TEXT_LENGTH, normalizeText, validNotebookSnapshot, validPageEdit, validPageText } from '../dist/index.js';

const box = (id, extra = {}) => ({id, x: 100, y: 200, width: 500, text: 'Skript: https://example.org', size: 'medium', color: '#243147', code: false, order: 0, ...extra});
const page = (extra = {}) => ({id: 'p', title: 'Seite 1', width: 1200, height: 1600, background: null, strokes: [], nextOrder: 5, ...extra});
const snapshot = p => ({type: 'notebook', notebook: {id: 'n', title: 'N', topics: [{id: 't', title: 'T', pages: [p]}]}, position: {pageId: 'p', y: 0}});

test('text boxes are validated', () => {
  assert.equal(validPageText(box('a'), 1600), true);
  assert.equal(validPageText(box('a', {code: true, size: 'large', text: '  eingerückt'}), 1600), true);
  for (const bad of [box('a', {text: '   '}), box('a', {text: 'x'.repeat(MAX_TEXT_LENGTH + 1)}), box('a', {size: 'huge'}), box('a', {color: 'red'}),
    box('a', {width: 30}), box('a', {x: 1000}), box('a', {y: 1700}), box('a', {code: 'yes'}), box('a b'), box('a', {order: -1})])
    assert.equal(validPageText(bad, 1600), false, JSON.stringify(bad));
});

test('typed text is normalized: line endings, trailing whitespace, empty and too long', () => {
  assert.equal(normalizeText('  code\r\n    indented  \r\n\n'), '  code\n    indented');
  assert.equal(normalizeText(' \n\t'), null);
  assert.equal(normalizeText('ä'.repeat(MAX_TEXT_LENGTH)), 'ä'.repeat(MAX_TEXT_LENGTH));
  assert.equal(normalizeText('ä'.repeat(MAX_TEXT_LENGTH + 1)), null);
});

test('snapshots and edits carry text boxes; stroke-only edits keep their old shape', () => {
  assert.equal(validNotebookSnapshot(snapshot(page({texts: [box('a'), box('b', {order: 1})]}))), true);
  assert.equal(validNotebookSnapshot(snapshot(page({texts: [box('a'), box('a', {order: 1})]}))), false);
  assert.equal(validNotebookSnapshot(snapshot(page({texts: Array.from({length: MAX_PAGE_TEXTS + 1}, (_, i) => box(`t${i}`))}))), false);
  const history = new EditHistory();
  assert.deepEqual(Object.keys(history.record('p', 1600, [], [])).sort(), ['height', 'id', 'insert', 'pageId', 'remove']);
  const edit = history.record('p', 1600, [], [], {texts: {insert: [box('a')], removed: []}});
  assert.equal(validPageEdit(edit), true);
  assert.deepEqual([edit.insertTexts, edit.removeTexts, edit.insertImages], [[box('a')], [], undefined]);
});

test('applying edits inserts, edits (remove + insert) and removes text boxes; undo restores them', () => {
  const notebook = snapshot(page()).notebook, history = new EditHistory(), target = () => notebook.topics[0].pages[0];
  const apply = edit => applyNotebookEvent(notebook, {type: 'edit', edit});
  apply(history.record('p', 1600, [], [], {texts: {insert: [box('a', {order: 9})], removed: []}}));
  assert.equal(target().nextOrder, 10);
  apply(history.record('p', 1600, [], [], {texts: {insert: [box('a', {order: 9, text: 'Neu'})], removed: [target().texts[0]]}}));
  assert.equal(target().texts[0].text, 'Neu');
  apply(history.undo());
  assert.equal(target().texts[0].text, 'Skript: https://example.org');
  apply(history.record('p', 1600, [], [], {texts: {insert: [], removed: [target().texts[0]]}}));
  assert.deepEqual(target().texts, []);
});
