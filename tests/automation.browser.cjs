// Requires Playwright and Chromium. Run with: node --test tests/automation.browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const userscript = process.env.AUTOMATION_USERSCRIPT || path.join(__dirname, '..', 'main.user.js');
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function fixture(t, body, pathname = '/watch?v=first') {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body }));
  await page.goto('https://www.youtube.com' + pathname);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.evaluate(() => {
    window.GM_addStyle = window.GM_registerMenuCommand = window.GM_setValue = () => {};
    window.GM_getValue = (key, fallback) => key === 'yt/functionState_01' ? {
      isOpenCommentTable: false, isOpenThemeProgressBar: false, isOpenSpeedControl: false, isOpenMarkOrRemoveAd: false
    } : fallback;
    const video = document.querySelector('video');
    if (video) Object.defineProperties(video, { paused: { value: false }, readyState: { value: 4 } });
  });
  return page;
}

const watch = content => '<ytd-watch-flexy video-id="first"><div id="movie_player"><video></video>'
  + content + '</div></ytd-watch-flexy>';

test('Framegen remembers a manual toggle across timestamp changes and enables the next video', async t => {
  const page = await fixture(t, watch('<div class="fc-controls-root"><button class="fc-side" aria-label="Toggle Framegen" aria-pressed="true">FG</button></div>'));
  await page.evaluate(() => {
    const button = document.querySelector('.fc-side');
    button.onclick = () => button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') === 'false');
  });
  await page.addScriptTag({ path: userscript });
  await page.evaluate(() => {
    document.querySelector('.fc-side').click();
    history.replaceState(null, '', '/watch?v=first&t=30');
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await page.clock.runFor(3200);
  assert.equal(await page.locator('.fc-side').getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    history.pushState(null, '', '/watch?v=next');
    document.querySelector('ytd-watch-flexy').setAttribute('video-id', 'next');
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await page.clock.runFor(3200);
  assert.equal(await page.locator('.fc-side').getAttribute('aria-pressed'), 'true');
});

test('missing optional controls have bounded query counts and an unsupported settings menu opens once', async t => {
  const page = await fixture(t, watch('<button class="ytp-settings-button" aria-expanded="false">Settings</button>'
    + '<div class="ytp-panel-menu"><div role="menuitem">Quality</div></div>'));
  await page.evaluate(() => {
    const pageRoot = document.querySelector('ytd-watch-flexy');
    const settings = document.querySelector('.ytp-settings-button');
    const video = pageRoot.querySelector('video');
    const readBounds = video.getBoundingClientRect.bind(video);
    window.counts = { settings: 0, framegen: 0, ask: 0, videoBounds: 0 };
    video.getBoundingClientRect = () => { counts.videoBounds++; return readBounds(); };
    settings.onclick = () => {
      counts.settings++;
      settings.setAttribute('aria-expanded', settings.getAttribute('aria-expanded') === 'false');
    };
    const lookup = document.querySelector.bind(document);
    document.querySelector = selector => {
      if (selector.includes('Toggle Framegen')) counts.framegen++;
      return lookup(selector);
    };
    const lookupButtons = pageRoot.querySelectorAll.bind(pageRoot);
    pageRoot.querySelectorAll = selector => {
      if (selector.includes('질문하기')) counts.ask++;
      return lookupButtons(selector);
    };
  });
  await page.addScriptTag({ path: userscript });
  await page.clock.runFor(18500);
  const counts = await page.evaluate(() => window.counts);
  t.diagnostic(JSON.stringify(counts));
  assert.equal(counts.settings, 2);
  assert.ok(counts.framegen > 0 && counts.framegen <= 20);
  assert.ok(counts.ask > 0 && counts.ask <= 15);
  assert.ok(counts.videoBounds > 0 && counts.videoBounds <= 3);
  assert.equal(await page.locator('.ytp-settings-button').getAttribute('aria-expanded'), 'false');
  await page.clock.runFor(3000);
  assert.deepEqual(await page.evaluate(() => window.counts), counts);
});

test('delayed ambient and summary controls are each used once', async t => {
  const page = await fixture(t, watch('<button class="ytp-settings-button" aria-expanded="false">Settings</button>'
    + '<div class="ytp-panel-menu"><div role="menuitem">Quality</div></div><ytd-watch-metadata></ytd-watch-metadata>'));
  await page.evaluate(() => {
    const settings = document.querySelector('.ytp-settings-button');
    window.counts = { settings: 0, ambient: 0, ask: 0, summary: 0 };
    settings.onclick = () => {
      counts.settings++;
      const open = settings.getAttribute('aria-expanded') === 'false';
      settings.setAttribute('aria-expanded', open);
      if (open) setTimeout(() => {
        const ambient = document.createElement('button');
        ambient.setAttribute('role', 'menuitemcheckbox');
        ambient.setAttribute('aria-checked', 'true');
        ambient.textContent = 'Ambient mode';
        ambient.onclick = () => { counts.ambient++; ambient.setAttribute('aria-checked', 'false'); };
        document.querySelector('.ytp-panel-menu').replaceChildren(ambient);
      }, 100);
    };
    setTimeout(() => {
      const ask = document.createElement('button');
      ask.setAttribute('aria-label', '질문하기');
      ask.textContent = '질문하기';
      ask.onclick = () => {
        counts.ask++;
        const panel = document.createElement('ytd-engagement-panel-section-list-renderer');
        panel.setAttribute('target-id', 'PAyouchat');
        panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
        const summary = document.createElement('button');
        summary.textContent = '동영상을 요약해 줘';
        summary.onclick = () => counts.summary++;
        panel.append(summary);
        document.querySelector('ytd-watch-flexy').append(panel);
      };
      document.querySelector('ytd-watch-metadata').append(ask);
    }, 12800);
  });
  await page.addScriptTag({ path: userscript });
  await page.clock.runFor(16000);
  assert.deepEqual(await page.evaluate(() => window.counts), { settings: 2, ambient: 1, ask: 1, summary: 1 });
});

test('home player ignores class changes on its controls and reacts to a minimize transition', async t => {
  const page = await fixture(t, '<div id="movie_player"><div id="clock"></div><button class="ytp-miniplayer-close-button">Close</button></div>', '/');
  await page.evaluate(() => {
    const clock = document.querySelector('#clock');
    const player = document.querySelector('#movie_player');
    window.closeClicks = 0;
    document.querySelector('button').onclick = () => window.closeClicks++;
    const lookup = document.querySelector.bind(document);
    window.homeQueries = 0;
    document.querySelector = selector => {
      if (selector === 'ytd-miniplayer') window.homeQueries++;
      return lookup(selector);
    };
    window.exercisePlayer = async () => {
      const initial = window.homeQueries;
      for (let i = 0; i < 20; i++) {
        clock.className = 'position-' + i;
        await Promise.resolve();
      }
      const noiseQueries = window.homeQueries - initial;
      player.classList.add('ytp-player-minimized');
      await Promise.resolve();
      return { noiseQueries, closeClicks };
    };
  });
  await page.addScriptTag({ path: userscript });
  assert.deepEqual(await page.evaluate(() => window.exercisePlayer()), { noiseQueries: 0, closeClicks: 1 });
});
