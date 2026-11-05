// Requires Playwright and Chromium. Run with: node --test tests/settings.browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('only user actions persist changes in the GM settings dialog', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.route('**/*', route => route.fulfill({
    contentType: 'text/html', body: '<body><label for="blockHomeMiniplayer">Outside</label></body>'
  }));
  await page.goto('https://www.youtube.com/feed/subscriptions');
  await page.evaluate(() => {
    window.writes = [];
    window.GM_getValue = (key, fallback) => key === 'yt/functionState_01'
      ? { isOpenCommentTable: false } : fallback;
    window.GM_setValue = (key, value) => writes.push([key, structuredClone(value)]);
    window.GM_registerMenuCommand = (name, handler) => { window.openSettings = handler; };
    window.GM_addStyle = () => {};
    // Keep a fixture-only handle so we can exercise and relocate the actual controls.
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) {
      const root = attachShadow.call(this, options);
      if (options.mode === 'closed') window.testSettingsRoot = root;
      return root;
    };
  });
  await page.addScriptTag({ path: path.join(__dirname, '..', 'main.user.js') });
  await page.evaluate(() => window.openSettings());
  assert.deepEqual(await page.evaluate(() => {
    const host = document.querySelector('.dialog-gcc-mask');
    document.querySelector('label').click();
    return [host.shadowRoot, document.querySelector('#blockHomeMiniplayer'), writes];
  }), [null, null, []]);

  const checkbox = await page.evaluateHandle(() => testSettingsRoot.querySelector('#blockHomeMiniplayer'));
  const label = await page.evaluateHandle(() => testSettingsRoot.querySelector('label[for="blockHomeMiniplayer"]'));
  const delay = await page.evaluateHandle(() => testSettingsRoot.querySelector('#framegenDelaySeconds'));
  await checkbox.evaluate(input => {
    input.click();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const parent = input.parentNode;
    document.body.append(input);
    input.click();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    parent.prepend(input);
    input.checked = true;
  });
  await label.evaluate(element => element.click());
  assert.deepEqual(await page.evaluate(() => writes), []);
  await label.asElement().click();
  await checkbox.asElement().focus();
  await page.keyboard.press('Space');
  assert.deepEqual(await page.evaluate(() => writes), [
    ['yt/blockHomeMiniplayer', false], ['yt/blockHomeMiniplayer', true]
  ]);

  await delay.asElement().click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('14');
  // The site can still edit the focused control via a document command.
  await page.evaluate(() => document.execCommand('insertText', false, '9'));
  await page.keyboard.press('Tab');
  assert.equal(await delay.evaluate(input => input.valueAsNumber), 14);
  await delay.asElement().focus();
  await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.evaluate(() => writes.slice(2)), [
    ['yt/framegenAuto', { enabled: true, delaySeconds: 14 }],
    ['yt/framegenAuto', { enabled: true, delaySeconds: 15 }]
  ]);
});
