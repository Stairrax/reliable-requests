const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

export const isRetryableStatus = status => RETRY_STATUSES.has(status);
export const defaultShouldRetryError = error => error instanceof TypeError;
export const abortError = () => new DOMException('Request cancelled', 'AbortError');

export function retryAfterMs(response, now = Date.now()) {
  const value = response?.headers?.get('retry-after')?.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds * 1000 : Infinity;
  }
  if (!/[A-Za-z]/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function retryDelayMs({ attempt, response, remainingMs, random = Math.random, now = Date.now() }) {
  const server = retryAfterMs(response, now);
  const base = Math.min(250 * 2 ** (attempt - 1), 5000);
  const delay = Math.ceil(server === null
    ? base * (0.8 + 0.2 * random())
    : server + Math.min(base * 0.2, 250) * random());
  return Number.isFinite(delay) && delay < remainingMs ? delay : null;
}

export function pause(ms, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function discardResponse(response) {
  try { response?.body?.cancel?.().catch(() => {}); } catch {}
}
