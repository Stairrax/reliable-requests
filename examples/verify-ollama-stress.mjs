// Optional real Ollama stress check: repeated long outputs, no artificial network faults.
// The test only sends text to an already-running Ollama server on local loopback.
import { streamLocalChat } from '../src/local-chat.js';
import { createStreamMetrics } from '../src/metrics.js';

const model = process.env.MODEL_NAME || 'qwen2.5:0.5b';
const endpoint = process.env.OLLAMA_ENDPOINT || 'http://127.0.0.1:11434';
const rounds = Number(process.env.STRESS_ROUNDS || 2);
const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 240_000);

function validate() {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username ||
      url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Stress test connects only to a local HTTP Ollama server at 127.0.0.1');
  }
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5) {
    throw new Error('STRESS_ROUNDS must be an integer from 1 to 5');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 1_200_000) {
    throw new Error('MODEL_TIMEOUT_MS must be an integer from 1000 to 1200000');
  }
  if (!model || model.length > 256) throw new Error('MODEL_NAME must be a model name');
}

async function checkModel() {
  const response = await fetch(new URL('/api/tags', endpoint), {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error('Ollama returned HTTP ' + response.status);
  const data = await response.json();
  if (!data.models?.some(entry => entry.name === model)) {
    throw new Error('Model "' + model + '" is not installed. Check: ollama list');
  }
}

async function main() {
  validate();
  await checkModel();

  console.log('Long-stream diagnostics with local Ollama ' + model + '.');
  console.log('Rounds: ' + rounds + '; each request has a ' + timeoutMs + ' ms deadline.');
  console.log('No connection is deliberately broken; Ctrl+C stops the script.');
  console.log('Memory is sampled for diagnostics, not a proof of leak freedom.\n');

  for (let round = 1; round <= rounds; round++) {
    const measurements = {
      baselineHeapMiB: process.memoryUsage().heapUsed / 1048576,
      peakHeapMiB: process.memoryUsage().heapUsed / 1048576,
      sampleCount: 0,
      chunks: 0,
      characters: 0,
    };
    const metrics = createStreamMetrics();
    const sampleMemory = () => {
      measurements.peakHeapMiB = Math.max(
        measurements.peakHeapMiB, process.memoryUsage().heapUsed / 1048576,
      );
      measurements.sampleCount++;
    };

    console.log('Round ' + round + '/' + rounds + ': generating a numbered list...');
    const result = await streamLocalChat({
      endpoint,
      protocol: 'ollama',
      model,
      messages: [{
        role: 'user',
        content: 'Write a numbered list of 60 distinct practical tips for writing reliable ' +
          'JavaScript applications. Give each tip a short explanation. Output only the list.',
      }],
      retries: 0,
      timeoutMs,
      onEvent(event) {
        metrics.record(event);
        if (event.type === 'delta') {
          measurements.chunks++;
          measurements.characters += event.text.length;
          if (measurements.chunks % 50 === 0) sampleMemory();
        }
      },
    });
    metrics.finish();
    sampleMemory();
    const summary = metrics.snapshot();

    if (result.attempts !== 1 || !summary.completed || summary.retries ||
        summary.resets || !measurements.characters) {
      throw new Error('The generation did not complete cleanly in round ' + round);
    }

    console.log('  PASS: ' + measurements.characters + ' characters in ' +
      measurements.chunks + ' chunks, ' + summary.elapsedMs + ' ms.');
    console.log('  Heap: start ' + measurements.baselineHeapMiB.toFixed(1) +
      ' MiB, sampled peak ' + measurements.peakHeapMiB.toFixed(1) +
      ' MiB, end ' + (process.memoryUsage().heapUsed / 1048576).toFixed(1) + ' MiB.');
    if (measurements.characters < 500) {
      console.log('  Note: this answer was short, so it does not prove long-answer stability.');
    }
  }
  console.log('\nPASS: all ' + rounds + ' live Ollama round(s) completed; no retries or resets.');
  console.log('Heap values are approximate snapshots; native memory and model-process memory are excluded.');
}

try {
  await main();
} catch (error) {
  console.error('\nFAIL: ' + (error.code || error.name) + ': ' + error.message);
  console.error('Check Ollama, your installed model, and the configured deadline.');
  process.exitCode = 1;
}
