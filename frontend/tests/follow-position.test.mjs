import test from 'node:test';
import assert from 'node:assert/strict';
import {followScrollTop} from '../dist/follow-position.js';

test('writing at different heights does not change the followed scroll position', () => {
    for (const focusY of [null, 200, 800, 1200]) {
        assert.equal(followScrollTop({pageId:'page', y:100, focusY}, 1200,
            {top:62, width:960}, 50, 0), 92);
    }
});

test('document top follows instructor scrolling at the reader scale, including paper padding', () => {
    const viewportTop = 50, inset = 12;
    for (const width of [600, 960, 1800]) {
        for (const previous of [0, 750, 4800]) {
            const position = {pageId:'page', y:1500};
            const target = followScrollTop(position, 1200,
                {top:viewportTop + inset - previous, width}, viewportTop, previous);
            assert.equal(target, inset + position.y * width / 1200);
            assert.equal((target - inset) * 1200 / width, position.y);
        }
    }
});

test('returning to the top preserves the page margin', () => {
    assert.equal(followScrollTop({pageId:'page', y:0, focusY:1500}, 1200,
        {top:-938, width:960}, 50, 1000), 0);
});
