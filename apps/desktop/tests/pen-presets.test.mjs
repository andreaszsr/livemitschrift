import test from 'node:test';
import assert from 'node:assert/strict';
import {penPreferences, writingActionIds, updatedWritingPins} from '../.test-build/pen-presets.js';

test('default presets expose writing actions only and return independent editable data', () => {
    const pen = penPreferences(null), next = penPreferences(null);
    assert.equal(pen.color, '#243147'); assert.equal(pen.width, 3.5);
    assert.equal(pen.colors.length, 4); assert.equal(pen.widths.length, 3);
    const ids = writingActionIds(pen);
    assert.deepEqual(ids.slice(0, 4), ['undo', 'redo', 'pen', 'eraser']);
    assert.ok(!ids.some(id => ['zoom', 'import', 'share'].includes(id)));
    pen.colors[0] = '#ffffff'; assert.equal(next.colors[0], '#243147');
});

test('stored favorites reject malformed, duplicate and unsafe drawing values', () => {
    const pen = penPreferences({colors:['#AABBCC', '#aabbcc', 'red', '<script>'],
        widths:[0, .5, NaN, Infinity, 3.5, 3.5, 21], color:'#AABBCC', width:3.5});
    assert.deepEqual(pen.colors, ['#aabbcc']); assert.deepEqual(pen.widths, [.5, 3.5]);
    assert.equal(pen.color, '#aabbcc'); assert.equal(pen.width, 3.5);
    const invalid = penPreferences({colors:[], widths:['4'], color:'red', width:99});
    assert.deepEqual(invalid.colors, penPreferences(null).colors);
    assert.deepEqual(invalid.widths, penPreferences(null).widths);
});

test('favorites and selected pen round-trip and removed selections fall back to available values', () => {
    const marker = {markerColors:['#ffd400', '#7ed957'], markerColor:'#7ed957', markerWidths:[8, 14], markerWidth:8};
    const value = {colors:['#123456', '#abcdef'], widths:[2, 8], color:'#abcdef', width:8, ...marker};
    assert.deepEqual(penPreferences(JSON.parse(JSON.stringify(value))), value);
    assert.deepEqual(penPreferences({...value, colors:['#123456'], widths:[2], markerColors:['#ffd400'], markerWidths:[12]}),
        {colors:['#123456'], widths:[2], color:'#123456', width:2, markerColors:['#ffd400'], markerColor:'#ffd400', markerWidths:[12], markerWidth:12});
});

test('new favorites become visible while existing order and deliberately hidden slots are retained', () => {
    const marker = {markerColors:['#ffd400'], markerWidths:[14]};
    const oldIds = writingActionIds(penPreferences(marker));
    const nextIds = writingActionIds(penPreferences({...marker, colors:['#111111', '#222222', '#333333', '#444444', '#555555']}));
    assert.deepEqual(updatedWritingPins(['pen', 'undo', 'color-0', 'width-1'], oldIds, nextIds),
        ['pen', 'undo', 'color-0', 'width-1', 'color-4']);
    assert.deepEqual(updatedWritingPins(['undo', 'color-4'], nextIds, oldIds), ['undo']);
});

test('additional custom colors and widths survive saving beyond the former favorite limits', () => {
    const colors = Array.from({length: 12}, (_, index) => `#${(index * 12345).toString(16).padStart(6, '0')}`);
    const widths = [.5, 1, 1.5, 2, 3.5, 7, 10, 12, 16, 20];
    const pen = penPreferences({colors, widths, color: colors[9], width: 16});
    const {markerColors, markerColor, markerWidths, markerWidth, ...penOnly} = penPreferences(JSON.parse(JSON.stringify(pen)));
    assert.ok(markerWidths.includes(markerWidth));
    assert.deepEqual(penOnly, {colors, widths, color: colors[9], width:16});
    assert.equal(markerColor, markerColors[0]);
    assert.ok(writingActionIds(pen).includes('color-11'));
    assert.ok(writingActionIds(pen).includes('width-9'));
});

test('marker colors have their own validated palette and share the toolbar color slots', () => {
    const defaults = penPreferences(null);
    assert.deepEqual(defaults.markerColors, ['#ffd400', '#7ed957', '#5ce1e6', '#ff66c4', '#ffa14a']);
    assert.equal(defaults.markerColor, '#ffd400');
    const custom = penPreferences({markerColors:['#FFD400', 'yellow', '#ffd400', '#00ff00'], markerColor:'#00FF00'});
    assert.deepEqual(custom.markerColors, ['#ffd400', '#00ff00']); assert.equal(custom.markerColor, '#00ff00');
    assert.equal(penPreferences({markerColors:['#00ff00'], markerColor:'#123456'}).markerColor, '#00ff00');
    // Four pen colors, five marker colors: five shared slots, no duplicates.
    const ids = writingActionIds(defaults);
    assert.deepEqual(ids.filter(id => id.startsWith('color-')), ['color-0', 'color-1', 'color-2', 'color-3', 'color-4']);
    assert.ok(ids.includes('lasso') && ids.includes('highlighter'));
});

test('marker widths default to 8/14/20, are bounded like pen widths and share the width slots', () => {
    const defaults = penPreferences(null);
    assert.deepEqual(defaults.markerWidths, [8, 14, 20]); assert.equal(defaults.markerWidth, 14);
    const custom = penPreferences({markerWidths:[0, 10, 10, 25, NaN, 18], markerWidth:18});
    assert.deepEqual(custom.markerWidths, [10, 18]); assert.equal(custom.markerWidth, 18);
    assert.equal(penPreferences({markerWidths:[6, 9, 12], markerWidth:99}).markerWidth, 9);
    const ids = writingActionIds(penPreferences({widths:[2], markerWidths:[8, 14, 20]}));
    assert.deepEqual(ids.filter(id => id.startsWith('width-')), ['width-0', 'width-1', 'width-2']);
});
