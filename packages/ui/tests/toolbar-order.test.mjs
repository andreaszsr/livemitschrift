import test from 'node:test';
import assert from 'node:assert/strict';
import {movePinnedAction} from '../dist/toolbar-order.js';

test('dragging inserts before a row or after the last row without mutating saved input', () => {
    const pinned = ['undo', 'pen', 'eraser', 'color-0'];
    assert.deepEqual(movePinnedAction(pinned, 'color-0', 'toolbar', 'pen'), ['undo', 'color-0', 'pen', 'eraser']);
    assert.deepEqual(movePinnedAction(pinned, 'undo', 'toolbar'), ['pen', 'eraser', 'color-0', 'undo']);
    assert.deepEqual(movePinnedAction(pinned, 'pen', 'toolbar', 'pen'), pinned);
    assert.deepEqual(pinned, ['undo', 'pen', 'eraser', 'color-0']);
});

test('moving between toolbar and overflow retains the chosen order without duplicate actions', () => {
    const hidden = movePinnedAction(['undo', 'pen', 'eraser'], 'pen', 'menu');
    assert.deepEqual(hidden, ['undo', 'eraser']);
    const restored = movePinnedAction(hidden, 'pen', 'toolbar', 'undo');
    assert.deepEqual(restored, ['pen', 'undo', 'eraser']);
    assert.deepEqual(movePinnedAction(restored, 'pen', 'toolbar', 'eraser'), ['undo', 'pen', 'eraser']);
});
