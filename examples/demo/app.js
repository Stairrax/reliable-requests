import { streamLocalChat } from '/src/local-chat.js';
import { createStreamMetrics } from '/src/metrics.js';

const $ = id => document.getElementById(id);
const modes = document.querySelectorAll('input[name="mode"]');
const startButton = $('run');
const stopButton = $('stop');
let controller = null;
let tick = null;

function mode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function selectMode() {
  $('liveConfig').hidden = mode() !== 'live';
}
for (const item of modes) item.addEventListener('change', selectMode);
$('protocol').addEventListener('change', () => {
  $('endpoint').value = $('protocol').value === 'ollama'
    ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1';
});
selectMode();

function status(label, kind = 'ready') {
  $('status').textContent = label;
  $('status').dataset.kind = kind;
}

function addEvent(message, kind = '') {
  const item = document.createElement('li');
  if (kind) item.className = 'event-' + kind;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  const label = document.createElement('span');
  label.textContent = message;
  item.append(time, label);
  $('events').prepend(item);
  while ($('events').children.length > 40) $('events').lastElementChild.remove();
}

function showMetrics(metrics) {
  const data = metrics.snapshot();
  $('attempts').textContent = String(data.attempts);
  $('retries').textContent = String(data.retries);
  $('resets').textContent = String(data.resets);
  $('characters').textContent = String(data.visibleCharacters);
  $('elapsed').textContent = data.elapsedMs + ' ms';
  $('firstDelta').textContent = data.timeToFirstDeltaMs === null
    ? '—' : data.timeToFirstDeltaMs + ' ms';
}

function simulatedFetch() {
  let calls = 0;
  return async (_url, init) => {
    if (init.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    calls++;
    const first = calls === 1;
    const event = text => 'data: ' + JSON.stringify({
      choices: [{ delta: { content: text } }],
    }) + '\n\n';
    const parts = first
      ? [event('This reply is incomplete. The connection will drop...')]
      : [event('A fresh response has started. '),
        event('The earlier partial answer was discarded, so these words are not mixed with it.'),
        'data: [DONE]\n\n'];
    const stream = new ReadableStream({
      start(source) {
        let index = 0;
        let pending;
        const push = () => {
          if (index >= parts.length) { source.close(); return; }
          source.enqueue(new TextEncoder().encode(parts[index++]));
          pending = setTimeout(push, 320);
        };
        pending = setTimeout(push, 220);
        this.cancelPending = () => clearTimeout(pending);
      },
      cancel() { this.cancelPending?.(); },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

function localOnly(endpoint) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('The live demo accepts only your own localhost model server.');
  }
  return url.href;
}

async function run() {
  if (controller) return;
  const localController = new AbortController();
  controller = localController;
  const metrics = createStreamMetrics();
  const simulation = mode() === 'simulation';
  const protocol = simulation ? 'openai' : $('protocol').value;
  const prompt = $('prompt').value.trim();
  $('events').replaceChildren();
  $('output').textContent = '';
  startButton.disabled = true;
  stopButton.disabled = false;
  status('Streaming…', 'running');
  tick = setInterval(() => showMetrics(metrics), 100);
  try {
    if (!prompt) throw new Error('Enter a message first.');
    const endpoint = simulation ? 'http://127.0.0.1:1234'
      : localOnly($('endpoint').value.trim());
    const model = simulation ? 'demo-model' : $('model').value.trim();
    if (!model) throw new Error('Enter an installed model name.');
    await streamLocalChat({
      endpoint, protocol, model,
      messages: [{ role: 'user', content: prompt }],
      retries: simulation ? 1 : 2,
      timeoutMs: simulation ? 15000 : 180000,
      signal: localController.signal,
      ...(simulation ? { fetchImpl: simulatedFetch() } : {}),
      onEvent(event) {
        metrics.record(event);
        if (event.type === 'attempt') addEvent('Generation attempt ' + event.attempt);
        if (event.type === 'delta') $('output').textContent += event.text;
        if (event.type === 'retry') {
          status('Retrying…', 'running');
          addEvent('Connection interrupted. Starting a fresh answer.', 'error');
        }
        if (event.type === 'reset') {
          $('output').textContent = '';
          addEvent('Discarded partial text before attempt ' + event.attempt, 'reset');
        }
        if (event.type === 'done') {
          status('Completed', 'success');
          addEvent('Response completed', 'done');
        }
        showMetrics(metrics);
      },
    });
  } catch (error) {
    const cancelled = localController.signal.aborted;
    status(cancelled ? 'Stopped' : 'Failed', cancelled ? 'ready' : 'error');
    addEvent(cancelled ? 'Cancelled by user' : (error.message || String(error)), cancelled ? '' : 'error');
    if (!cancelled && !simulation) addEvent('Check your model name, running server, and browser CORS settings.');
  } finally {
    clearInterval(tick);
    tick = null;
    metrics.finish();
    showMetrics(metrics);
    controller = null;
    startButton.disabled = false;
    stopButton.disabled = true;
  }
}
startButton.addEventListener('click', run);
stopButton.addEventListener('click', () => controller?.abort());
