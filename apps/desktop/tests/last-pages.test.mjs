import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLastPages, rememberPage, resumePage} from '../.test-build/last-pages.js';

test('the last page is remembered per notebook and per topic', () => {
    let pages = parseLastPages(undefined);
    pages = rememberPage(pages, 'book', 'topic-1', 'p2');
    pages = rememberPage(pages, 'book', 'topic-2', 'p7');
    assert.deepEqual(pages, {notebooks: {book: 'p7'}, topics: {'topic-1': 'p2', 'topic-2': 'p7'}});
    assert.deepEqual(parseLastPages(JSON.stringify(pages)), pages);
});

test('deleted pages fall back to the first page; broken preferences are ignored', () => {
    const list = [{id: 'p1'}, {id: 'p2'}];
    assert.equal(resumePage(list, 'p2').id, 'p2');
    assert.equal(resumePage(list, 'gone').id, 'p1');
    assert.equal(resumePage(list, undefined).id, 'p1');
    assert.equal(resumePage([], 'p1'), undefined);
    assert.deepEqual(parseLastPages('{broken'), {notebooks: {}, topics: {}});
    assert.deepEqual(parseLastPages(JSON.stringify({notebooks: {a: 1, b: 'p'}, topics: []})), {notebooks: {b: 'p'}, topics: {}});
});

test('the maps stay bounded and keep the most recent entries', () => {
    let pages = parseLastPages(undefined);
    for (let index = 0; index < 510; index++) pages = rememberPage(pages, 'book', `t${index}`, `p${index}`);
    assert.equal(Object.keys(pages.topics).length, 500);
    assert.equal(pages.topics.t509, 'p509');
    assert.equal(pages.topics.t0, undefined);
});
