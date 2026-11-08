/**
 * Optional, lightweight stream diagnostics.
 * Characters are JavaScript string lengths, NOT tokens or network bytes.
 * This observer never changes retry behavior and sends no telemetry.
 */
export function createStreamMetrics({ now = () => performance.now() } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const startedAt = now();
  let finishedAt = null;
  const state = {
    attempts: 0, retries: 0, resets: 0, deltaEvents: 0,
    receivedCharacters: 0, visibleCharacters: 0,
    timeToFirstDeltaMs: null, completed: false,
  };
  const elapsed = (end = now()) => Math.max(0, Math.round(end - startedAt));
  return {
    record(event) {
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'attempt') state.attempts++;
      if (event.type === 'retry') state.retries++;
      if (event.type === 'reset') {
        state.resets++;
        state.visibleCharacters = 0;
      }
      if (event.type === 'delta' && typeof event.text === 'string') {
        if (state.timeToFirstDeltaMs === null) state.timeToFirstDeltaMs = elapsed();
        state.deltaEvents++;
        state.receivedCharacters += event.text.length;
        state.visibleCharacters += event.text.length;
      }
      if (event.type === 'done') {
        state.completed = true;
        if (finishedAt === null) finishedAt = now();
      }
    },
    finish() {
      if (finishedAt === null) finishedAt = now();
    },
    snapshot() {
      return Object.freeze({
        ...state,
        elapsedMs: elapsed(finishedAt === null ? now() : finishedAt),
      });
    },
  };
}
