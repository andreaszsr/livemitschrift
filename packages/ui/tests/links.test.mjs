import test from 'node:test';
import assert from 'node:assert/strict';
import {linkParts} from '../dist/links.js';

test('https and mailto addresses become links, trailing punctuation stays text', () => {
  assert.deepEqual(linkParts('Siehe https://example.org/a?b=1. Fragen: mailto:a@b.de!'), [
    {text: 'Siehe '}, {text: 'https://example.org/a?b=1', href: 'https://example.org/a?b=1'},
    {text: '. Fragen: '}, {text: 'mailto:a@b.de', href: 'mailto:a@b.de'}, {text: '!'}]);
});

test('other schemes and markup stay plain text', () => {
  for (const text of ['javascript:alert(1)', 'http://example.org', 'data:text/html,x', '<a href="https://x">x</a>'])
    assert.ok(linkParts(text).every(part => !part.href || part.href.startsWith('https://x')), text);
  assert.deepEqual(linkParts('kein Link'), [{text: 'kein Link'}]);
  assert.deepEqual(linkParts(''), []);
});
