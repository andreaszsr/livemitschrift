import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_NOTE_LENGTH, MAX_NOTES, mergeNotes, noteText, NoteStore, pageNotes, parseNotes, serializeNotes, validNote} from '../dist/student-notes.js';

const note = (id, extra = {}) => ({id, pageId: 'page-1', x: 100, y: 200, text: `Notiz ${id}`, created: 1, updated: 1, ...extra});
class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

test('notes are validated strictly and invalid entries are dropped', () => {
  assert.equal(validNote(note('a')), true);
  for (const bad of [note('a b'), note('a', {pageId: ''}), note('a', {x: 1201}), note('a', {y: -1}), note('a', {text: '  '}),
    note('a', {text: 'x'.repeat(MAX_NOTE_LENGTH + 1)}), note('a', {updated: 1.5}), null, 'note'])
    assert.equal(validNote(bad), false, JSON.stringify(bad));
  const parsed = parseNotes(JSON.stringify({notes: [note('a', {extra: '<script>'}), {id: 'x'}, note('a', {text: 'doppelt'})]}));
  assert.deepEqual(parsed, [note('a', {text: 'doppelt'})]);
  assert.throws(() => parseNotes('{"foo": 1}'), /Keine LiveMitschrift-Notizen/);
});

test('serialized notes round-trip, also as a bare list', () => {
  const notes = [note('a'), note('b', {text: 'Ümläute und 😀'})];
  assert.deepEqual(parseNotes(serializeNotes(notes, 'book')), notes);
  assert.deepEqual(parseNotes(JSON.stringify(notes)), notes);
});

test('imports add new notes and replace only older versions', () => {
  const result = mergeNotes([note('a', {updated: 5}), note('b', {updated: 5})],
    [note('a', {text: 'neuer', updated: 9}), note('b', {text: 'älter', updated: 2}), note('c')]);
  assert.equal(result.added, 1);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.notes.map(item => item.text), ['neuer', 'Notiz b', 'Notiz c']);
});

test('notes of a page are numbered in reading order', () => {
  const numbered = pageNotes([note('a', {y: 500}), note('b', {y: 100, x: 900}), note('c', {y: 100, x: 50}), note('d', {pageId: 'other'})], 'page-1');
  assert.deepEqual(numbered.map(({note, number}) => `${number}:${note.id}`), ['1:c', '2:b', '3:a']);
});

test('note text is normalized and bounded', () => {
  assert.equal(noteText('  Zeile 1\r\nZeile 2 '), 'Zeile 1\nZeile 2');
  assert.equal(noteText('   '), null);
  assert.equal(noteText('x'.repeat(MAX_NOTE_LENGTH + 1)), null);
});

test('the store persists, edits and removes notes in its storage', () => {
  const storage = new MemoryStorage(), store = new NoteStore(storage, 'notes-x');
  store.save(note('a'));
  store.save(note('a', {text: 'geändert', updated: 2}));
  store.save(note('b'));
  assert.deepEqual(new NoteStore(storage, 'notes-x').all.map(item => item.text), ['geändert', 'Notiz b']);
  store.remove('a');
  assert.deepEqual(new NoteStore(storage, 'notes-x').all.map(item => item.id), ['b']);
  assert.deepEqual(new NoteStore(storage, 'other').all, []);
});

test('unavailable, full or corrupt storage is handled', () => {
  assert.deepEqual(new NoteStore(null, 'k').all, []);
  assert.throws(() => new NoteStore(null, 'k').save(note('a')), /keine lokale Speicherung/);
  const full = new MemoryStorage();
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  const store = new NoteStore(full, 'k');
  assert.throws(() => store.save(note('a')), /Quota/);
  assert.deepEqual(store.all, []);
  const corrupt = new MemoryStorage();
  corrupt.setItem('k', '{not json');
  assert.deepEqual(new NoteStore(corrupt, 'k').all, []);
});

test('the number of notes is limited', () => {
  const store = new NoteStore(new MemoryStorage(), 'k');
  store.replace(Array.from({length: MAX_NOTES}, (_, index) => note(`n${index}`)));
  assert.throws(() => store.save(note('extra')), /Höchstens/);
  store.save(note('n0', {text: 'Bearbeiten geht weiterhin'}));
});
