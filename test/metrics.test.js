import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamMetrics } from '../src/metrics.js';

test('stream metrics count attempts, resets, retries, and visible output separately', () => {
  let clock = 0;
  const metrics = createStreamMetrics({ now: () => clock });
  metrics.record({ type: 'attempt', attempt: 1 });
  clock = 30;
  metrics.record({ type: 'delta', text: 'old' });
  clock = 80;
  metrics.record({ type: 'retry', attempt: 1 });
  metrics.record({ type: 'reset', attempt: 2 });
  metrics.record({ type: 'attempt', attempt: 2 });
  clock = 120;
  metrics.record({ type: 'delta', text: 'new!' });
  clock = 160;
  metrics.record({ type: 'done' });
  assert.deepEqual(metrics.snapshot(), {
    attempts: 2, retries: 1, resets: 1, deltaEvents: 2,
    receivedCharacters: 7, visibleCharacters: 4,
    timeToFirstDeltaMs: 30, completed: true, elapsedMs: 160,
  });
  clock = 999;
  assert.equal(metrics.snapshot().elapsedMs, 160, 'completed duration is stable');
});

test('metrics can finalize failure and do not mistake text length for tokens', () => {
  let clock = 100;
  const metrics = createStreamMetrics({ now: () => clock });
  metrics.record({ type: 'attempt' });
  metrics.record({ type: 'delta', text: '🙂' });
  clock = 150;
  metrics.finish();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.completed, false);
  assert.equal(snapshot.elapsedMs, 50);
  assert.equal(snapshot.receivedCharacters, 2);
  assert.equal(snapshot.visibleCharacters, 2);
  assert.equal(snapshot.timeToFirstDeltaMs, 0);
  assert.throws(() => { snapshot.resets = 999; }, TypeError);
});

test('metric events cannot mutate the underlying stream or perform I/O', () => {
  const metrics = createStreamMetrics();
  metrics.record(null);
  metrics.record({ type: 'ignored' });
  assert.equal(metrics.snapshot().attempts, 0);
  assert.throws(() => createStreamMetrics({ now: 123 }), TypeError);
});
