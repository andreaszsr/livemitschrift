import test from 'node:test';
import assert from 'node:assert/strict';
import {ViewportZoom, zoomAnchor, zoomPreferences, addZoomLockAction} from '../dist/zoom.js';

function setup(native = false, slideHeight = null) {
  globalThis.window = new EventTarget(); globalThis.document = {querySelector: () => null};
  globalThis.getComputedStyle = () => ({paddingTop: '0px'});
  const frames = new Map(); let id = 0, changes = 0, gestures = 0, finishes = 0;
  globalThis.requestAnimationFrame = callback => {frames.set(++id, callback); return id;};
  globalThis.cancelAnimationFrame = frame => frames.delete(frame);
  const viewport = new EventTarget();
  Object.assign(viewport, {clientWidth: 800, clientHeight: 600, scrollLeft: 0, scrollTop: 600,
    getBoundingClientRect: () => ({left: 0, top: 0, right: 800, bottom: 600})});
  const paper = {style: {width: '1200px'}, getBoundingClientRect() {
    const capped = /^min\(100%, ([\d.]+)px\)$/.exec(this.style.width);
    const width = this.style.width === '100%' ? viewport.clientWidth : capped ? Math.min(viewport.clientWidth, Number(capped[1])) : parseFloat(this.style.width);
    return {width, left: Math.max(0, (viewport.clientWidth - width) / 2) - viewport.scrollLeft, top: 12 - viewport.scrollTop};
  }};
  const zoom = new ViewportZoom(paper, viewport, {width: 1200, height: 6000}, {
    native, changed: () => changes++, beforeChange: () => finishes++, gesture: () => gestures++, slideHeight: () => slideHeight,
  });
  zoom.configure({value: '100'});
  const event = (target, type, data) => {const event = Object.assign(new Event(type, {cancelable: true}), data); target.dispatchEvent(event); return event;};
  const wheel = deltaY => event(viewport, 'wheel', {ctrlKey: true, deltaY, deltaMode: 0, clientX: 400, clientY: 300});
  const magnify = amount => event(window, 'livemitschrift-native-zoom', {detail: {phase: 'change', magnification: amount, x: 400, y: 300}});
  const frame = () => {const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback());};
  const anchor = () => zoomAnchor(paper.getBoundingClientRect(), 1200, {x: 400, y: 300});
  return {zoom, viewport, paper, event, wheel, magnify, frame, anchor, counts: () => ({changes, gestures, finishes})};
}

test('pinch zoom retains the document point at the gesture center after scroll and centering', () => {
  const {zoom, wheel, frame, anchor} = setup(); const before = anchor(); wheel(-Math.log(1.5) / .01); frame();
  assert.equal(Number(zoom.value), 150); assert.deepEqual(anchor(), before);
});

test('native magnification is applied once while DOM gesture/wheel duplicates are suppressed', () => {
  const {zoom, wheel, magnify, event, viewport, frame} = setup(true);
  magnify(.25); wheel(-100);
  event(viewport, 'gesturestart', {scale: 1, clientX: 400, clientY: 300});
  event(viewport, 'gesturechange', {scale: 2, clientX: 400, clientY: 300}); frame();
  assert.equal(Number(zoom.value), 125);
});

test('zoom lock suppresses gestures and explicit changes, and freezes fit across resize', () => {
  const {zoom, viewport, paper, wheel, frame, counts} = setup();
  zoom.set('fit'); zoom.setLocked(true); const value = zoom.value, before = counts();
  const event = wheel(-100); frame(); zoom.set('200');
  assert.equal(event.defaultPrevented, true); assert.equal(zoom.value, value); assert.deepEqual(counts(), before);
  viewport.clientWidth = 600; zoom.resize(); assert.ok(Math.abs(paper.getBoundingClientRect().width - 800) < 1e-8);
  zoom.setLocked(false); zoom.set('200'); assert.equal(zoom.value, '200');
});

test('multiple gesture samples are accumulated into a single rendering frame and bounded', () => {
  const {zoom, magnify, frame, counts} = setup(true); magnify(.1); magnify(.1); frame();
  assert.ok(Math.abs(Number(zoom.value) - 121) < .0001); assert.equal(counts().changes, 1);
  magnify(1000); frame(); assert.equal(zoom.value, '400'); magnify(-.99); frame(); assert.equal(zoom.value, '25');
});

test('touch pinch scales the document without creating any drawing input', () => {
  const {zoom, event, viewport, frame} = setup();
  event(viewport, 'touchstart', {touches: [{clientX: 100, clientY: 200}, {clientX: 200, clientY: 200}]});
  const move = event(viewport, 'touchmove', {touches: [{clientX: 50, clientY: 200}, {clientX: 250, clientY: 200}]}); frame();
  assert.equal(move.defaultPrevented, true); assert.equal(zoom.value, '200');
});

test('ordinary two-finger scrolling is left to the viewport and modal dialogs block zoom', () => {
  const {zoom, event, viewport, wheel, frame, counts} = setup();
  const scroll = event(viewport, 'wheel', {ctrlKey: false, deltaY: 100}); frame(); assert.equal(scroll.defaultPrevented, false);
  document.querySelector = () => ({}); wheel(-100); frame(); assert.equal(zoom.value, '100'); assert.equal(counts().changes, 0);
});

test('saved settings reject invalid geometry and toolbar migration preserves intentional menu actions', () => {
  assert.deepEqual(zoomPreferences({value: 'NaN', locked: true}), {value: 'fit', locked: true});
  assert.deepEqual(zoomPreferences({value: '125', locked: false}), {value: '125', locked: false});
  const toolbar = {pinned: ['pen', 'zoom', 'share']};
  assert.deepEqual(addZoomLockAction(toolbar, null).pinned, ['pen', 'zoom', 'zoom-lock', 'share']);
  assert.deepEqual(toolbar.pinned, ['pen', 'zoom', 'share']);
  assert.equal(addZoomLockAction(toolbar, {value: '125'}), toolbar);
});

test('fit uses the full window width and "whole slide" fits the slide height into the viewport', () => {
  const {zoom, viewport, paper} = setup(false, 900);
  viewport.clientWidth = 1900; zoom.set('fit');
  assert.equal(paper.getBoundingClientRect().width, 1900);
  zoom.set('page');
  // Inner height 600 - 4 px maps to the 900-unit slide: width = 596 * 1200 / 900.
  assert.ok(Math.abs(paper.getBoundingClientRect().width - 596 * 1200 / 900) < 1e-6);
  viewport.clientWidth = 500; zoom.resize();
  assert.equal(paper.getBoundingClientRect().width, 500);
  assert.deepEqual(zoomPreferences({value: 'page', locked: false}), {value: 'page', locked: false});
});
