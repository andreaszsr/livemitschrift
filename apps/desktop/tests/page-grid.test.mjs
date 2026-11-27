import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveGrid, gridBackground, gridSpacingUnits, NO_GRID, parseGrid, parseNotebookGrid, serializeNotebookGrid} from '../.test-build/page-grid.js';

const squares = {style: 'squares', spacing: 5}, dots = {style: 'dots', spacing: 8}, off = {style: 'none', spacing: 5};

test('a page uses its own grid, else its topic grid, else the notebook default', () => {
    const grid = {default: squares, topics: {t2: dots}, pages: {p3: off}};
    assert.deepEqual(effectiveGrid(grid, 't1', 'p1'), squares);
    assert.deepEqual(effectiveGrid(grid, 't2', 'p2'), dots);
    assert.deepEqual(effectiveGrid(grid, 't2', 'p3'), off);
});

test('stored grids are validated; invalid parts fall back or are dropped', () => {
    assert.deepEqual(parseNotebookGrid(undefined), {default: NO_GRID, topics: {}, pages: {}});
    assert.deepEqual(parseNotebookGrid('{broken'), {default: NO_GRID, topics: {}, pages: {}});
    const parsed = parseNotebookGrid(JSON.stringify({default: {style: 'hex', spacing: 5}, topics: {t: dots, u: {style: 'lines', spacing: 7}}, pages: {p: {...squares, extra: 1}}}));
    assert.deepEqual(parsed, {default: NO_GRID, topics: {t: dots}, pages: {p: squares}});
    assert.deepEqual(parseGrid(JSON.stringify(dots)), dots);
    assert.deepEqual(parseGrid('null'), NO_GRID);
});

test('serializing round-trips and forgets deleted topics and pages', () => {
    const grid = {default: dots, topics: {t: squares, gone: off}, pages: {p: off, old: squares}};
    assert.deepEqual(parseNotebookGrid(serializeNotebookGrid(grid, ['t'], ['p'])), {default: dots, topics: {t: squares}, pages: {p: off}});
});

test('spacing is millimetres on an A4-wide page and scales with the paper width', () => {
    assert.ok(Math.abs(gridSpacingUnits(5) - 5 * 1200 / 210) < 1e-9);
    assert.equal(gridBackground(off), null);
    // Repeating gradients over the whole layer (no tiles), period = spacing in container units.
    const squares5 = gridBackground(squares)['background-image'];
    assert.match(squares5, /^repeating-linear-gradient\(to right, #dbe2ec -0\.5px 0\.5px, transparent 0\.5px calc\(calc\(100cqw \* 0\.0238\d+\) - 0\.5px\)\), repeating-linear-gradient\(to bottom/);
    assert.equal(gridBackground({style: 'lines', spacing: 10})['background-image'].includes('to right'), false);
    const dotted = gridBackground(dots);
    assert.match(dotted['mask-image'], /to right, #000 -1px 1px.*to bottom, #000 -1px 1px/);
    assert.equal(dotted['mask-composite'], 'intersect');
});
