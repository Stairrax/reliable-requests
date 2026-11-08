// Cross-browser smoke check of the local stream lab; requires optional Playwright.
// Example: BROWSER_ENGINE=firefox npm run test:browser
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { startDemoServer } from '../examples/demo/server.mjs';

const engines = { chromium, firefox, webkit };
const engineName = process.env.BROWSER_ENGINE || 'chromium';
if (!Object.prototype.hasOwnProperty.call(engines, engineName)) {
  throw new Error('BROWSER_ENGINE must be chromium, firefox, or webkit');
}

const { server, url } = await startDemoServer({ port: 0 });
let browser;
try {
  browser = await engines[engineName].launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(url, { waitUntil: 'load' });
  assert.equal(await page.title(), 'Reliable Requests — Stream Lab');
  assert.equal(await page.locator('#liveConfig').isHidden(), true);

  // Verify live mode controls without making an external or local model call.
  await page.locator('input[name="mode"][value="live"]').check();
  assert.equal(await page.locator('#liveConfig').isVisible(), true);
  await page.locator('input[name="mode"][value="simulation"]').check();
  assert.equal(await page.locator('#liveConfig').isHidden(), true);

  // A simulated interrupted answer must be discarded before displaying a fresh one.
  await page.locator('#run').click();
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Completed',
    null,
    { timeout: 12_000 },
  );
  const output = await page.locator('#output').textContent();
  assert.ok(output.includes('A fresh response has started.'), output);
  assert.ok(!output.includes('This reply is incomplete.'), output);
  assert.equal(await page.locator('#attempts').textContent(), '2');
  assert.equal(await page.locator('#retries').textContent(), '1');
  assert.equal(await page.locator('#resets').textContent(), '1');
  assert.ok((await page.locator('#events').textContent()).includes('Discarded partial text'));

  // Cancellation should stop the second run promptly; no extra retry may start.
  await page.locator('#run').click();
  await page.locator('#stop').click();
  await page.waitForFunction(
    () => document.getElementById('status').textContent === 'Stopped',
    null,
    { timeout: 5_000 },
  );
  assert.equal(await page.locator('#stop').isDisabled(), true);
  assert.equal(await page.locator('#run').isEnabled(), true);
  assert.equal(await page.locator('#retries').textContent(), '0');
  assert.ok((await page.locator('#events').textContent()).includes('Cancelled by user'));
  assert.deepEqual(errors, []);
  console.log('PASS: simulated recovery, metrics, and cancellation in ' + engineName);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
