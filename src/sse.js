export class StreamLineTooLongError extends Error {
  constructor(maxLineChars) {
    super('A model stream line exceeded the ' + maxLineChars + ' character limit');
    this.name = 'StreamLineTooLongError';
    this.code = 'STREAM_LINE_TOO_LONG';
    this.maxLineChars = maxLineChars;
  }
}

export class StreamEventTooLongError extends Error {
  constructor(maxEventChars) {
    super('A model stream event exceeded the ' + maxEventChars + ' character limit');
    this.name = 'StreamEventTooLongError';
    this.code = 'STREAM_EVENT_TOO_LONG';
    this.maxEventChars = maxEventChars;
  }
}

export function createLineParser({ maxLineChars, onLine }) {
  let buffer = '';
  let skipLF = false;
  let stopped = false;

  function push(text) {
    let start = 0;
    if (skipLF && text.length) {
      if (text[0] === '\n') start = 1;
      skipLF = false;
    }
    while (start < text.length && !stopped) {
      let end = start;
      while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
      if (buffer.length + end - start > maxLineChars) throw new StreamLineTooLongError(maxLineChars);
      buffer += text.slice(start, end);
      if (end === text.length) break;
      const line = buffer;
      buffer = '';
      stopped = onLine(line) === false;
      start = end + 1;
      if (text[end] === '\r') {
        if (text[start] === '\n') start++;
        else if (start === text.length) skipLF = true;
      }
    }
  }

  function finish(flushTrailing = false) {
    if (!stopped && flushTrailing && buffer.length) onLine(buffer);
    buffer = '';
    stopped = true;
  }

  return { push, finish };
}

export function createSseParser({ maxLineChars, maxEventChars, onData }) {
  let data = '';
  let hasData = false;
  const lines = createLineParser({
    maxLineChars,
    onLine(line) {
      if (line === '') {
        if (!hasData) return;
        const event = data;
        data = '';
        hasData = false;
        return onData(event);
      }
      if (line[0] === ':') return;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      if (field !== 'data') return;
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value[0] === ' ') value = value.slice(1);
      const length = data.length + (hasData ? 1 : 0) + value.length;
      if (length > maxEventChars) throw new StreamEventTooLongError(maxEventChars);
      data += (hasData ? '\n' : '') + value;
      hasData = true;
    },
  });
  return {
    push: lines.push,
    finish() {
      lines.finish();
      data = '';
      hasData = false;
    },
  };
}
