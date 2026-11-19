// Requires Playwright and Chromium. Run with: node --test tests/layout.browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const userscript = process.env.LAYOUT_USERSCRIPT || path.join(__dirname, '..', 'main.user.js');

async function layoutPage(browser, body = '<body></body>') {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body }));
  await page.goto('https://www.youtube.com/feed/subscriptions');
  await page.evaluate(() => {
    window.GM_getValue = (key, defaultValue) => defaultValue;
    window.GM_addStyle = window.GM_registerMenuCommand = () => {};
    window.GM_addElement = (parent, name, properties) =>
      parent.appendChild(Object.assign(document.createElement(name), properties));
  });
  return page;
}

test('layout ignores unrelated root attributes and releases hidden chat observers', async () => {
  const browser = await chromium.launch();
  try {
    const page = await layoutPage(browser);
    await page.evaluate(() => {
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
    await page.addScriptTag({ path: userscript });
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

test('layout detects an existing or delayed player without polling feed mutations', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const alreadyReady of [false, true]) {
    const page = await layoutPage(browser);
    await page.evaluate(ready => {
      window.playerAPI = ready ? {} : null;
      window.playerReads = 0;
      Object.defineProperty(window, '_yt_player', { get() { window.playerReads++; return window.playerAPI; } });
    }, alreadyReady);
    await page.addScriptTag({ path: userscript });
    const state = await page.evaluate(async () => {
      const ready = () => document.documentElement.getAttribute('tabview-loaded').includes('p');
      const initial = ready();
      const before = window.playerReads;
      for (let i = 0; i < 20; i++) {
        document.body.append(document.createElement('article'));
        await Promise.resolve();
      }
      const feedReads = window.playerReads - before;
      window.playerAPI = {};
      document.dispatchEvent(new Event('yt-player-updated'));
      const afterReady = ready();
      const settled = window.playerReads;
      document.dispatchEvent(new Event('yt-player-updated'));
      return { initial, feedReads, afterReady, laterReads: window.playerReads - settled };
    });
    t.diagnostic(JSON.stringify(state));
    assert.deepEqual(state, { initial: alreadyReady, feedReads: 0, afterReady: true, laterReads: 0 });
    await page.close();
  }
});

test('removing old comments and live chat keeps the replacement panels responsive', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await layoutPage(browser, '<ytd-watch-flexy><div id="player"></div>'
    + '<div id="columns" class="style-scope ytd-watch-flexy"></div></ytd-watch-flexy>'
    + '<a tyt-tab-content="#tab-comments"></a>');
  await page.evaluate(() => {
    class Panel extends HTMLElement {
      get hostElement() { return this; }
      attached() {}
      detached() {}
      _createPropertyObserver() {}
    }
    customElements.define('ytd-comments', class extends Panel {});
    customElements.define('ytd-live-chat-frame', class extends Panel {});
  });
  await page.addScriptTag({ path: userscript });
  await page.waitForFunction(() => customElements.get('ytd-comments').prototype.attached498
    && customElements.get('ytd-live-chat-frame').prototype.attached498);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-finish'));
    window.addPanels = () => {
      const column = document.querySelector('#columns');
      const comments = document.createElement('ytd-comments');
      const chat = document.createElement('ytd-live-chat-frame');
      comments.id = 'comments';
      chat.id = 'chat';
      comments.className = chat.className = 'style-scope';
      column.prepend(comments, chat);
      comments.attached();
      chat.attached();
      return { comments, chat };
    };
    window.oldPanels = window.addPanels();
  });
  await page.waitForFunction(() => oldPanels.chat.hasAttribute('tyt-active-chat-frame') && oldPanels.comments.hasAttribute('tyt-comments-area'));
  await page.evaluate(() => { window.newPanels = window.addPanels(); });
  await page.waitForFunction(() => newPanels.chat.hasAttribute('tyt-active-chat-frame') && newPanels.comments.hasAttribute('tyt-comments-area'));
  const state = await page.evaluate(async () => {
    for (const old of Object.values(oldPanels)) { old.remove(); old.detached(); }
    await Promise.resolve();
    newPanels.chat.setAttribute('collapsed', '');
    newPanels.comments.setAttribute('tyt-comments-data-status', '2');
    await new Promise(resolve => setTimeout(resolve, 0));
    const flexy = document.querySelector('ytd-watch-flexy');
    return { chat: flexy.getAttribute('tyt-chat'), commentsDisabled: flexy.hasAttribute('tyt-comment-disabled'),
      tabHidden: document.querySelector('[tyt-tab-content]').classList.contains('tab-btn-hidden') };
  });
  assert.deepEqual(state, { chat: '-', commentsDisabled: true, tabHidden: false });
});
