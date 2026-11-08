// Optional Chromium smoke test of the interactive demo. Requires Playwright.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startDemoServer } from '../examples/demo/server.mjs';

const { server, url } = await startDemoServer({ port: 0 });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'load' });
  assert.equal(await page.title(), 'Reliable Requests — Stream Lab');
  assert.equal(await page.locator('#liveConfig').isHidden(), true);

  await page.locator('#run').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Completed', {
    timeout: 12000,
  });
  const output = await page.locator('#output').textContent();
  assert.ok(output.includes('A fresh response has started.'), output);
  assert.ok(!output.includes('This reply is incomplete.'), output);
  assert.equal(await page.locator('#attempts').textContent(), '2');
  assert.equal(await page.locator('#retries').textContent(), '1');
  assert.equal(await page.locator('#resets').textContent(), '1');
  assert.ok((await page.locator('#events').textContent()).includes('Discarded partial text'));

  await page.locator('#run').click();
  await page.locator('#stop').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Stopped', {
    timeout: 4000,
  });
  assert.equal(await page.locator('#stop').isDisabled(), true);
  assert.equal(await page.locator('#run').isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: demo stream recovery, event trace, metrics, and cancellation in Chromium');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
