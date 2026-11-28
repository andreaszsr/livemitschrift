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

test('lines break only at spaces: words are never split, an overlong word stays on its own line', () => {
  const width = Math.max(measureText('Skript zur', false, TEXT_FONT_SIZE.medium), measureText('Vorlesung', false, TEXT_FONT_SIZE.medium)) + 1;
  assert.ok(measureText('Skript zur Vorlesung', false, TEXT_FONT_SIZE.medium) > width);
  assert.deepEqual(layoutText('Skript zur Vorlesung', 'medium', false, width).lines, ['Skript zur', 'Vorlesung']);
  const narrow = measureText('asdfasd', false, TEXT_FONT_SIZE.medium) - 5;
  assert.deepEqual(layoutText('asdfasd sdfadf', 'medium', false, narrow).lines, ['asdfasd', 'sdfadf']);
  assert.deepEqual(layoutText('Siehe https://example.org/sehr/langer/pfad dort', 'medium', false, width).lines, ['Siehe', 'https://example.org/sehr/langer/pfad', 'dort']);
  assert.deepEqual(layoutText('a\n\nb', 'small', false, 500).lines, ['a', '', 'b']);
  // Start offsets locate each line in the text, also after dropped spaces and explicit breaks.
  const text = 'Skript zur Vorlesung\nhttps://example.org/sehr/langer/pfad', layout = layoutText(text, 'medium', false, width);
  layout.lines.forEach((line, index) => assert.equal(text.slice(layout.starts[index], layout.starts[index] + line.length), line));
  assert.deepEqual(layoutText('a\n\nb', 'small', false, 500).starts, [0, 2, 3]);
});

test('code keeps indentation and spaces and also breaks only at spaces; height and baseline follow the line count', () => {
  const width = measureText('x'.repeat(10), true, TEXT_FONT_SIZE.small);
  const layout = layoutText('    if (x) {\n        call(a, b);', 'small', true, width);
  assert.deepEqual(layout.lines, ['    if (x) ', '{', '        call(a, ', 'b);']);
  assert.equal(layout.lines.join('').replace(/ /g, ''), 'if(x){call(a,b);');
  assert.equal(layout.height, layout.lines.length * layout.lineHeight);
  assert.ok(layout.baseline > 0 && layout.baseline < layout.lineHeight);
});

test('hit testing uses the laid out height', () => {
  const box = {id: 'b', x: 100, y: 100, width: 200, text: 'eins zwei drei vier fünf sechs sieben', size: 'medium', color: '#000000', code: false, order: 1};
  const height = layoutText(box.text, 'medium', false, 200).height;
  assert.equal(textAt([box], {x: 150, y: 100 + height - 1})?.id, 'b');
  assert.equal(textAt([box], {x: 150, y: 100 + height + 1}), null);
});
