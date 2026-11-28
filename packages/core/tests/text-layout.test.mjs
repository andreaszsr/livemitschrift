import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutText, measureText, MONO_METRICS, SANS_METRICS, textAt, textFontHasCharacter, TEXT_FONT_SIZE } from '../dist/index.js';

test('metrics come from the bundled fonts: monospace has one advance, sans varies', () => {
  assert.equal(SANS_METRICS.unitsPerEm, 1000);
  assert.ok(measureText('iiii', false, 28) < measureText('MMMM', false, 28));
  assert.equal(measureText('iiii', true, 28), measureText('MMMM', true, 28));
  assert.ok(Math.abs(measureText('a', true, 1000) - 600) < 1, 'Noto Sans Mono advance is 600 units');
  assert.ok(textFontHasCharacter(false, '∑') && textFontHasCharacter(false, '→') && textFontHasCharacter(true, 'ä'));
  assert.equal(textFontHasCharacter(false, '😀'), false);
  assert.ok(MONO_METRICS.ascent > 0 && MONO_METRICS.descent < 0);
});

test('normal text wraps at spaces, keeps explicit breaks and splits only overlong words', () => {
  const width = Math.max(measureText('Skript zur', false, TEXT_FONT_SIZE.medium), measureText('Vorlesung', false, TEXT_FONT_SIZE.medium)) + 1;
  assert.ok(measureText('Skript zur Vorlesung', false, TEXT_FONT_SIZE.medium) > width);
  assert.deepEqual(layoutText('Skript zur Vorlesung\nhttps://example.org/sehr/langer/pfad', 'medium', false, width).lines.slice(0, 2), ['Skript zur', 'Vorlesung']);
  const long = layoutText('https://example.org/sehr/langer/pfad', 'medium', false, width);
  assert.ok(long.lines.length > 1 && long.lines.every(line => measureText(line, false, 28) <= width + 1e-6));
  assert.equal(long.lines.join(''), 'https://example.org/sehr/langer/pfad');
  assert.deepEqual(layoutText('a\n\nb', 'small', false, 500).lines, ['a', '', 'b']);
});

test('code wraps at any character and keeps spaces; height and baseline follow the line count', () => {
  const columns = 10, width = measureText('x'.repeat(columns), true, TEXT_FONT_SIZE.small);
  const layout = layoutText('    if (x) {\n        y();', 'small', true, width);
  assert.deepEqual(layout.lines, ['    if (x)', ' {', '        y(', ');']);
  assert.equal(layout.height, 4 * layout.lineHeight);
  assert.ok(layout.baseline > 0 && layout.baseline < layout.lineHeight);
});

test('hit testing uses the laid out height', () => {
  const box = {id: 'b', x: 100, y: 100, width: 200, text: 'eins zwei drei vier fünf sechs sieben', size: 'medium', color: '#000000', code: false, order: 1};
  const height = layoutText(box.text, 'medium', false, 200).height;
  assert.equal(textAt([box], {x: 150, y: 100 + height - 1})?.id, 'b');
  assert.equal(textAt([box], {x: 150, y: 100 + height + 1}), null);
});
