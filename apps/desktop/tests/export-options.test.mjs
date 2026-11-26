import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultExportRange, exportFileName, formatPageRange, parsePageRange, validExportFileName} from '../.test-build/export-options.js';

test('page lists accept ranges, single pages, spaces and en dashes', () => {
  assert.deepEqual(parsePageRange('2-5,7', 10), [2, 3, 4, 5, 7]);
  assert.deepEqual(parsePageRange(' 7 , 2 – 3, 3 ', 10), [2, 3, 7]);
  assert.deepEqual(parsePageRange('4,', 4), [4]);
});

test('invalid or out-of-range page lists are rejected', () => {
  for (const text of ['', ' , ', '0', '5-3', '11', '2-11', 'a', '2-', '1;2', '-3'])
    assert.equal(parsePageRange(text, 10), null, text);
});

test('page lists are formatted compactly', () => {
  assert.equal(formatPageRange([1, 2, 3, 5, 7, 8]), '1-3,5,7-8');
  assert.equal(formatPageRange([4]), '4');
  assert.equal(formatPageRange([]), '');
});

test('the default range starts after the previous export and ends at the visible page', () => {
  assert.equal(defaultExportRange(null, 6), '1-6');
  assert.equal(defaultExportRange(3, 7), '4-7');
  assert.equal(defaultExportRange(6, 7), '7');
  assert.equal(defaultExportRange(9, 7), '7');
  assert.equal(defaultExportRange(null, 1), '1');
});

test('default file names use notebook, topic and the local date, without unsafe characters', () => {
  const date = new Date(2026, 10, 26, 23, 30);
  assert.equal(exportFileName('Mathe 1', 'Kapitel 3', date), 'Mathe 1_Kapitel 3-2026-11-26');
  assert.equal(exportFileName('A/B: C?', '..Thema\n2', date), 'A-B- C-_Thema-2-2026-11-26');
  assert.equal(exportFileName('', '???', date), 'Notizbuch_----2026-11-26');
});

test('user file names drop ".pdf" and reject paths and hidden names', () => {
  assert.equal(validExportFileName(' Vorlesung 3.pdf '), 'Vorlesung 3');
  assert.equal(validExportFileName('Übung_1'), 'Übung_1');
  for (const name of ['', '.pdf', '.versteckt', '../x', 'a/b', 'a:b', 'x'.repeat(201)])
    assert.equal(validExportFileName(name), null, name);
});
