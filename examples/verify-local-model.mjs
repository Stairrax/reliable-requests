// Smoke-test a real running local text model. No extra dependencies.
import { streamLocalChat } from '../src/local-chat.js';

const protocol = process.env.MODEL_PROTOCOL || 'ollama';
const endpoint = process.env.MODEL_ENDPOINT ||
  (protocol === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1');
const model = process.env.MODEL_NAME;
const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 180_000);

if (!model) {
  console.error('Set MODEL_NAME to a model already installed on your local server.');
  console.error('Example: MODEL_PROTOCOL=ollama MODEL_NAME=qwen2.5:7b npm run test:model');
  process.exit(2);
}

let answer = '';
let chunks = 0;
let resets = 0;
const started = Date.now();

console.log('Checking ' + protocol + ' at ' + endpoint + ' using model ' + model);
try {
  const result = await streamLocalChat({
    endpoint,
    protocol,
    model,
    messages: [{ role: 'user', content: 'Explain why HTTP timeouts matter in one short sentence.' }],
    retries: 0,
    timeoutMs,
    onEvent(event) {
      if (event.type === 'attempt') console.log('Attempt ' + event.attempt + ' started');
      if (event.type === 'reset') { resets++; answer = ''; console.log('\n[reset]'); }
      if (event.type === 'delta') { chunks++; answer += event.text; process.stdout.write(event.text); }
      if (event.type === 'retry') console.log('\n[retry] ' + event.error.message);
    },
  });
  console.log('\n');
  if (!answer.trim()) throw new Error('Server completed the stream without returning text');
  console.log('PASS: ' + chunks + ' text chunks, ' + result.attempts + ' attempt(s), ' +
    resets + ' resets, ' + (Date.now() - started) + ' ms.');
} catch (error) {
  console.error('\nFAIL: ' + (error.code || error.name) + ': ' + error.message);
  console.error('Check the server URL, installed model name, and timeout setting.');
  process.exitCode = 1;
}
