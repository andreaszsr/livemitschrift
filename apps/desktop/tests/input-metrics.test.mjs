import test from 'node:test';
import assert from 'node:assert/strict';
import { InputMetrics } from '../.test-build/input-metrics.js';
const sample = (timestamp, sequence, extra = {}) => ({source: 'appkit', pointerType: 'pen', pressure: .3, button: 0, buttons: 1, phase: 'AppKit drag', sampleCount: 1, coalesced: false, inContact: true, eraser: false, timestamp, sequence, sentAt: 1000, queueDelayMs: .2, mouseCoalescingEnabled: false, ...extra});

test('event timestamps measure source frequency independently of JS delivery bursts', () => {
  const metrics = new InputMetrics(); metrics.start();
  for (let i = 0; i < 241; i++) metrics.observe(sample(i * 1000 / 240, i + 1), 1002);
  const report = metrics.stop();
  assert.ok(Math.abs(report.eventHz - 240) < .001); assert.equal(report.events, 241);
  assert.equal(report.deliveryMs.p95, 2); assert.equal(report.appKitQueueMs.p95, .2);
  assert.equal(report.missingSequences, 0); assert.equal(report.mouseCoalescingEnabled, false);
});

test('pen-up pauses and mouse events do not dilute the contact frequency or fake bridge loss', () => {
  const metrics = new InputMetrics(); metrics.start();
  metrics.observe(sample(0, 1)); metrics.observe(sample(10, 2));
  metrics.observe(sample(11, 3, {inContact: false, pressure: 0}));
  metrics.observe(sample(1000, 4, {pointerType: 'mouse'}));
  metrics.observe(sample(2000, 5)); metrics.observe(sample(2010, 6));
  const report = metrics.stop(); assert.equal(report.eventHz, 100); assert.equal(report.events, 4); assert.equal(report.missingSequences, 0);
});

test('missing sequences and repeated timestamps are reported, never counted as extra Hz', () => {
  const metrics = new InputMetrics(); metrics.start();
  metrics.observe(sample(10, 10)); metrics.observe(sample(10, 11)); metrics.observe(sample(20, 14));
  const report = metrics.stop(); assert.equal(report.eventHz, 100); assert.equal(report.duplicateTimestamps, 1); assert.equal(report.missingSequences, 2);
});

test('accepted points are counted separately; gaps use screen scale without retaining geometry', () => {
  const metrics = new InputMetrics(); metrics.start();
  metrics.accept([{x: 100, y: 100, pressure: .3}], 2, true);
  metrics.accept([{x: 103, y: 104, pressure: .3}], 2);
  metrics.processed(.4);
  const report = metrics.stop(); assert.equal(report.points, 2); assert.equal(report.strokes, 1); assert.equal(report.pointStepsPx.max, 10); assert.equal(report.processingMs.p95, .4);
  assert.equal(JSON.stringify(report).includes('pressure'), false);
  metrics.accept([{x: 1000, y: 1000, pressure: .3}], 1);
  assert.equal(metrics.snapshot().points, 2);
  metrics.start(); assert.equal(metrics.snapshot().points, 0);
});

test('wall-clock rounding retains sub-millisecond arrivals and flags actual clock mismatch', () => {
  const metrics = new InputMetrics(); metrics.start();
  metrics.observe(sample(0, 1, {sentAt: 1000.8}), 1000);
  metrics.observe(sample(10, 2, {sentAt: 1000}), 1002);
  metrics.observe(sample(20, 3, {sentAt: 1020}), 1010);
  const report = metrics.stop(); assert.equal(report.deliveryMs.count, 2); assert.equal(report.deliveryMs.mean, 1); assert.equal(report.clockWarnings, 1);
});

test('focus changes flag an interrupted profile without changing native arrival counts', () => {
  const metrics = new InputMetrics(); metrics.focusChanged(); metrics.start();
  metrics.observe(sample(10, 1)); metrics.focusChanged(); metrics.observe(sample(20, 2));
  const report = metrics.stop(); metrics.focusChanged();
  assert.equal(report.focusChanges, 1); assert.equal(report.events, 2); assert.equal(report.missingSequences, 0);
  assert.equal(metrics.snapshot().focusChanges, 1);
});
