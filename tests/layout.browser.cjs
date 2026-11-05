// Requires Playwright and Chromium. Run with: node --test tests/layout.browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');

test('layout ignores unrelated root attributes and releases hidden chat observers', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
    await page.goto('https://www.youtube.com/feed/subscriptions');
    await page.evaluate(() => {
      window.GM_getValue = (key, defaultValue) => defaultValue;
      window.GM_addStyle = window.GM_registerMenuCommand = () => {};
      window.GM_addElement = (parent, name, properties) =>
        parent.appendChild(Object.assign(document.createElement(name), properties));
      window.rootNoiseCallbacks = 0;
      window.chatObservers = 0;
      window.MutationObserver = class extends MutationObserver {
        constructor(callback) {
          super((records, observer) => {
            if (this.observesRootAttributes && records.some(record => record.attributeName === 'data-layout-test-noise'))
              window.rootNoiseCallbacks++;
            callback(records, observer);
          });
        }
        observe(target, options) {
          if (target === document.documentElement && !options.subtree && (options.attributes || options.attributeFilter))
            this.observesRootAttributes = true;
          return super.observe(target, options);
        }
      };
      window.IntersectionObserver = class extends IntersectionObserver {
        observe(target) {
          if (target.id === 'test-chat-frame') {
            this.watchingTestFrame = true;
            window.chatObservers++;
          }
          return super.observe(target);
        }
        disconnect() {
          if (this.watchingTestFrame) window.chatObservers--;
          this.watchingTestFrame = false;
          return super.disconnect();
        }
      };
      customElements.define('ytd-live-chat-frame', class extends HTMLElement {
        urlChanged() { this.urlChanges = (this.urlChanges || 0) + 1; }
      });
    });
    await page.addScriptTag({ path: process.env.LAYOUT_USERSCRIPT || path.join(__dirname, '..', 'main.user.js') });
    await page.waitForFunction(() => typeof customElements.get('ytd-live-chat-frame').prototype.urlChangedAsync12 === 'function');
    const state = await page.evaluate(async () => {
      for (let index = 0; index < 20; index++) {
        document.documentElement.setAttribute('data-layout-test-noise', index);
        await Promise.resolve();
      }
      document.body.setAttribute('data-ytlstm-new-layout', '');
      await Promise.resolve();
      const chat = document.createElement('ytd-live-chat-frame');
      const frame = document.createElement('iframe');
      frame.id = 'test-chat-frame';
      frame.hidden = true;
      document.body.append(chat, frame);
      chat.chatframe = frame;
      chat.data = {};
      await chat.urlChangedAsync12();
      const hidden = { changes: chat.urlChanges, observers: window.chatObservers };
      frame.hidden = false;
      await chat.urlChangedAsync12();
      return {
        noiseCallbacks: window.rootNoiseCallbacks,
        detectedPlugin: document.documentElement.classList.contains('external-ytlstm'),
        hidden,
        shown: { changes: chat.urlChanges, observers: window.chatObservers }
      };
    });
    assert.deepEqual(state, {
      noiseCallbacks: 0,
      detectedPlugin: true,
      hidden: { changes: 1, observers: 0 },
      shown: { changes: 2, observers: 0 }
    });
  } finally {
    await browser.close();
  }
});
