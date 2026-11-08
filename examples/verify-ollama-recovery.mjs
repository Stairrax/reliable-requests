// Exercise one real Ollama model with exactly one deliberately broken network stream.
import { createOneShotOllamaFaultProxy } from './ollama-fault-proxy.mjs';
import { streamLocalChat } from '../src/local-chat.js';
import { createStreamMetrics } from '../src/metrics.js';

const model = process.env.MODEL_NAME || 'qwen2.5:0.5b';
const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 180_000);
const ollamaUrl = process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';

async function main() {
  const health = new URL('/api/tags', ollamaUrl);
  if (health.protocol !== 'http:' || health.hostname !== '127.0.0.1') {
    throw new Error('This test only supports Ollama running at 127.0.0.1');
  }
  try {
    const response = await fetch(health, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Ollama returned HTTP ' + response.status);
    const listing = await response.json();
    const installed = listing.models?.map(item => item.name) || [];
    if (!installed.includes(model)) {
      throw new Error('Model "' + model + '" is not installed. Try: ollama list');
    }
  } catch (error) {
    throw new Error('Local Ollama check failed: ' + error.message);
  }

  const proxy = await createOneShotOllamaFaultProxy({ upstream: ollamaUrl });
  const metrics = createStreamMetrics();
  const events = [];
  let visible = '';
  try {
    console.log('Local model: ' + model);
    console.log('The test will interrupt the FIRST response after actual model text arrives.');
    console.log('Ollama stays running; the SECOND response will be delivered normally.\n');
    const result = await streamLocalChat({
      endpoint: proxy.endpoint,
      protocol: 'ollama',
      model,
      messages: [{
        role: 'user',
        content: 'Explain in two short sentences why a local AI app should handle broken network streams.',
      }],
      headers: { 'x-rr-test-token': proxy.token },
      timeoutMs,
      retries: 1,
      onEvent(event) {
        metrics.record(event);
        events.push(event.type);
        if (event.type === 'attempt') console.log('Generation attempt ' + event.attempt);
        if (event.type === 'delta') visible += event.text;
        if (event.type === 'retry') console.log('First connection interrupted: retrying safely');
        if (event.type === 'reset') {
          visible = '';
          console.log('RESET: discarded partial text before the new answer');
        }
        if (event.type === 'done') console.log('Second generation completed');
      },
    });
    metrics.finish();
    const proxyStats = proxy.snapshot();
    const summary = metrics.snapshot();
    if (result.attempts !== 2 || proxyStats.requests !== 2 ||
        proxyStats.forcedCuts !== 1 || summary.resets !== 1 || summary.retries !== 1 ||
        !events.includes('delta') || !visible.trim() || !summary.completed) {
      throw new Error('The recovery sequence was not completed as expected');
    }
    console.log('\nFinal answer after reset:\n' + visible.trim());
    console.log('\nPASS: 2 attempts, 1 real connection cut, 1 retry, 1 reset.');
    console.log('Elapsed: ' + summary.elapsedMs + ' ms; visible characters: ' +
      summary.visibleCharacters + '.');
    console.log('No text from the interrupted attempt was appended to the final answer.');
  } finally {
    await proxy.close();
  }
}

try {
  await main();
} catch (error) {
  console.error('\nFAIL: ' + (error.code || error.name) + ': ' + error.message);
  console.error('Check that Ollama is running and the model is installed (ollama list).');
  process.exitCode = 1;
}
