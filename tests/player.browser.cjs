const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { chromium } = require('playwright');

const userscript = path.join(__dirname, '..', 'main.user.js');
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const player = `<ytd-watch-flexy video-id="fixture"><div id="player-container-outer"><div class="html5-video-player" id="movie_player" tabindex="0">
  <video muted></video><div class="ytp-chrome-bottom"><div class="ytp-right-controls"></div></div>
</div></div></ytd-watch-flexy>`;
const style = '<style>#movie_player{position:relative;width:800px;height:400px}.ytp-chrome-bottom{position:absolute;bottom:0;left:0;width:100%;height:40px}.ytp-right-controls{position:absolute;bottom:0;right:40px;height:40px;display:flex}</style>';
const toolbox = '#toolBox_extension_codehemu_x';
const speed = '.SpeedControl_Extension_Btn_X';

async function fixture(t, { home = false, speedEnabled = true, clock = false } = {}) {
  const page = await browser.newPage({ acceptDownloads: true });
  if (clock)
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  t.after(() => page.close());
  await page.route('**/*', route => route.fulfill({
    contentType: 'text/html', body: `<!doctype html>${style}<body>${home ? '' : player}</body>`
  }));
  await page.addInitScript(enabled => {
    window.intervals = [];
    const interval = window.setInterval;
    window.setInterval = (fn, delay, ...args) => {
      window.intervals.push(delay);
      return interval(fn, delay, ...args);
    };
    window.GM_registerMenuCommand = () => {};
    window.GM_getValue = (key, fallback) => {
      if (key === 'yt/functionState_01') return { isOpenCommentTable: false, isOpenSpeedControl: enabled };
      if (key === 'yt/framegenAuto') return { enabled: false };
      if (key === 'yt/blockHomeMiniplayer') return false;
      const saved = localStorage.getItem(key);
      return saved === null ? fallback : JSON.parse(saved);
    };
    window.GM_setValue = (key, value) => localStorage.setItem(key, JSON.stringify(value));
    window.GM_addStyle = css => {
      const style = document.createElement('style');
      style.textContent = css;
      const add = () => (document.head || document.documentElement).appendChild(style);
      if (document.documentElement) add();
      else document.addEventListener('DOMContentLoaded', add, { once: true });
    };
  }, speedEnabled);
  await page.addInitScript({ path: userscript });
  await page.goto('https://www.youtube.com/' + (home ? '' : 'watch?v=fixture'));
  if (clock)
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  return page;
}

test('home starts without polling, late and replaced player controls mount once', async t => {
  const page = await fixture(t, { home: true });
  assert.deepEqual(await page.evaluate(() => window.intervals), []);
  assert.equal(await page.locator('style[id^="removeADHTMLElement_"]').count(), 1);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('yt-navigate-start'));
    history.pushState({}, '', '/watch?v=fixture');
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await page.locator('body').evaluate((body, html) => body.insertAdjacentHTML('beforeend', html), player);
  await page.locator(speed).waitFor();
  await page.locator('[data-speed="3.0"]').evaluate(option => option.click());
  await page.getByTitle('Loop', { exact: true }).evaluate(button => button.click());
  assert.deepEqual(await page.evaluate(() => [localStorage.length, document.querySelector('video').playbackRate]), [0, 1]);
  await page.locator(speed).hover();
  await page.locator('[data-speed="1.5"]').click();
  assert.equal(await page.locator('#youtube-extension-text-box').innerText(), '1.5×');
  await page.locator(toolbox).hover();
  await page.getByTitle('Loop', { exact: true }).click();
  await page.evaluate(() => {
    const fresh = document.createElement('video');
    document.querySelector('video').replaceWith(fresh);
    document.querySelector('.ytp-right-controls').replaceChildren();
    fresh.dispatchEvent(new Event('loadedmetadata'));
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  assert.equal(await page.locator(speed).innerText(), '1.5×');
  assert.equal(await page.locator(toolbox).count(), 1);
  assert.equal(await page.locator('#toolbox_extension_container').count(), 1);
  assert.equal(await page.locator('#SpeedControl_Extension_Speed-Options').count(), 1);
  assert.deepEqual(await page.locator('video').evaluate(v => [v.playbackRate, v.loop]), [1.5, true]);
  await page.locator('#youtube-extension-text-box').waitFor({ state: 'detached' });
});

test('theme switch preserves other YouTube PREF settings and flags', async t => {
  const page = await fixture(t, { speedEnabled: false });
  assert.equal(await page.locator(speed).count(), 0);
  await page.evaluate(() => { document.cookie = 'PREF=hl=ko&f6=8002a&extra=a=b; domain=.youtube.com; path=/; secure'; });
  await page.locator(toolbox).hover();
  await Promise.all([page.waitForEvent('load'), page.getByTitle('Switch the theme').click()]);
  assert.equal((await page.context().cookies()).find(c => c.name === 'PREF').value, 'hl=ko&f6=42a&extra=a=b');
  await page.locator(toolbox).hover();
  await Promise.all([page.waitForEvent('load'), page.getByTitle('Switch the theme').click()]);
  assert.equal((await page.context().cookies()).find(c => c.name === 'PREF').value, 'hl=ko&f6=8002a&extra=a=b');
});

async function playTestVideo(page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const video = document.querySelector('video');
    video.srcObject = canvas.captureStream();
    canvas.getContext('2d').fillRect(0, 0, 32, 32);
    await video.play();
  });
}

test('controls hide after one idle second under the pointer and remain available to keyboard focus', async t => {
  const page = await fixture(t, { clock: true });
  await playTestVideo(page);
  const controls = page.locator('.ytp-chrome-bottom');
  await page.evaluate(() => {
    const player = document.querySelector('#movie_player');
    window.originalPlayerParent = player.parentElement;
    document.body.append(player);
    document.querySelector('ytd-watch-flexy').setAttribute('video-id', '');
  });
  await page.mouse.move(100, 50);
  await page.clock.runFor(500);
  await page.evaluate(() => {
    originalPlayerParent.append(document.querySelector('#movie_player'));
    document.querySelector('#movie_player').focus();
    document.querySelector('ytd-watch-flexy').setAttribute('video-id', 'fixture');
    document.querySelector('ytd-watch-flexy').dispatchEvent(new Event('yt-navigate-finish'));
  });
  await page.clock.runFor(499);
  assert.equal(await controls.evaluate(el => getComputedStyle(el).opacity), '1');
  await page.clock.runFor(1);
  assert.equal(await controls.evaluate(el => getComputedStyle(el).opacity), '0');
  await page.mouse.move(101, 50);
  assert.equal(await controls.evaluate(el => getComputedStyle(el).opacity), '1');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'native-control';
    button.textContent = 'Playback';
    document.querySelector('.ytp-right-controls').prepend(button);
    document.querySelector('#movie_player').focus();
  });
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'native-control');
  await page.clock.runFor(1200);
  assert.equal(await controls.evaluate(el => getComputedStyle(el).opacity), '1');
  await page.evaluate(() => document.dispatchEvent(new Event('yt-navigate-start')));
  await page.clock.runFor(2000);
  assert.equal(await controls.evaluate(el => getComputedStyle(el).opacity), '1');
});

test('controls remain visible for open menus and held pointer gestures', async t => {
  const page = await fixture(t, { clock: true });
  await playTestVideo(page);
  const controls = page.locator('.ytp-chrome-bottom');
  await page.evaluate(() => {
    const menu = document.createElement('div');
    menu.className = 'ytp-contextmenu';
    menu.textContent = 'Menu';
    document.body.append(menu);
  });
  await page.mouse.move(100, 50);
  await page.clock.runFor(1500);
  assert.equal(await controls.evaluate(el => getComputedStyle(el).opacity), '1');
  await page.locator('.ytp-contextmenu').evaluate(menu => menu.style.display = 'none');
  await page.mouse.move(101, 50);
  await page.mouse.down();
  await page.clock.runFor(1500);
  assert.equal(await controls.evaluate(el => getComputedStyle(el).opacity), '1');
  await page.mouse.up();
  await page.clock.runFor(1000);
  assert.equal(await controls.evaluate(el => getComputedStyle(el).opacity), '0');
});

test('playback feedback shows the new state at quarter size, fades and honors reduced motion', async t => {
  const page = await fixture(t, { clock: true });
  await playTestVideo(page);
  await page.locator('video').click();
  const feedback = page.locator('.youtub-playback-feedback');
  assert.equal(await feedback.getAttribute('data-state'), 'pause');
  const pausePath = await feedback.locator('path').getAttribute('d');
  await feedback.evaluate(el => { el.getAnimations()[0].currentTime = 150; });
  const geometry = await feedback.evaluate(el => {
    const f = el.getBoundingClientRect();
    const p = el.parentElement.getBoundingClientRect();
    return { opacity: +getComputedStyle(el).opacity, width: f.width, shortSide: Math.min(p.width, p.height),
      offsetX: f.x + f.width / 2 - p.x - p.width / 2, offsetY: f.y + f.height / 2 - p.y - p.height / 2,
      pointerEvents: getComputedStyle(el).pointerEvents };
  });
  assert.ok(geometry.opacity > 0 && geometry.opacity < 1);
  assert.ok(geometry.width / geometry.shortSide > .2 && geometry.width / geometry.shortSide < .3);
  assert.ok(Math.abs(geometry.offsetX) < 1 && Math.abs(geometry.offsetY) < 1);
  assert.equal(geometry.pointerEvents, 'none');
  await feedback.evaluate(async el => {
    const animations = el.getAnimations();
    animations.forEach(animation => animation.finish());
    await Promise.all(animations.map(animation => animation.finished));
  });
  assert.equal(await feedback.evaluate(el => +getComputedStyle(el).opacity), 0);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('.youtub-playback-feedback')?.dataset.state === 'play');
  assert.notEqual(await feedback.locator('path').getAttribute('d'), pausePath);
  assert.equal(await feedback.count(), 1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('video').click();
  await feedback.evaluate(el => { el.getAnimations()[0].currentTime = 150; });
  assert.equal(await feedback.getAttribute('data-state'), 'pause');
  assert.equal(await feedback.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a), 1);
  await page.evaluate(() => document.querySelector('ytd-watch-flexy').dispatchEvent(new Event('yt-navigate-start')));
  assert.equal(await feedback.count(), 0);
});

test('video clicks and Space pause and resume even when native handlers do nothing', async t => {
  const page = await fixture(t);
  await playTestVideo(page);
  await page.locator('video').click();
  assert.equal(await page.locator('video').evaluate(v => v.paused), true);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('video').evaluate(v => v.paused), false);
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  assert.equal(await page.locator('video').evaluate(v => v.paused), true);
  await page.locator('#movie_player').click({ position: { x: 790, y: 50 } });
  assert.equal(await page.locator('video').evaluate(v => v.paused), false);
  await page.evaluate(() => {
    history.pushState(null, '', '/');
    document.querySelector('ytd-watch-flexy').setAttribute('video-id', '');
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await page.keyboard.press('Space');
  assert.equal(await page.locator('video').evaluate(v => v.paused), false);
});

test('playback input toggles once with native handlers and a Framegen canvas', async t => {
  const page = await fixture(t);
  await playTestVideo(page);
  await page.evaluate(() => {
    window.nativeToggles = 0;
    window.nativeDoubleClicks = 0;
    const video = document.querySelector('video');
    const nativeToggle = () => {
      nativeToggles++;
      if (video.paused) video.play(); else video.pause();
    };
    document.querySelector('#movie_player').addEventListener('click', nativeToggle);
    document.querySelector('#movie_player').addEventListener('dblclick', () => nativeDoubleClicks++);
    document.addEventListener('keydown', event => { if (event.key === ' ') nativeToggle(); });
    document.addEventListener('keyup', event => { if (event.key === ' ') nativeToggle(); });
    const canvas = document.createElement('canvas');
    canvas.id = 'framegen-output';
    canvas.style.cssText = 'position:absolute;inset:0;width:300px;height:150px;z-index:2';
    document.querySelector('video').after(canvas);
  });
  await page.locator('#framegen-output').click();
  assert.equal(await page.locator('video').evaluate(v => v.paused), true);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('video').evaluate(v => v.paused), false);
  assert.equal(await page.evaluate(() => nativeToggles), 0);
  await page.locator('#framegen-output').dblclick();
  assert.equal(await page.locator('video').evaluate(v => v.paused), false);
  assert.equal(await page.evaluate(() => nativeDoubleClicks), 1);
});

for (const menuClass of ['ytp-contextmenu', 'ytp-settings-menu']) {
  test(`video click dismisses an open ${menuClass} without toggling playback`, async t => {
    const page = await fixture(t);
    await playTestVideo(page);
    await page.evaluate(className => {
      const menu = document.createElement('div');
      menu.className = `ytp-popup ${className}`;
      // YouTube's context menu lives under body and can still have aria-hidden=true while opening.
      menu.setAttribute('aria-hidden', 'true');
      menu.style.cssText = 'display:none;position:absolute;left:500px;top:10px;width:150px;height:80px';
      menu.textContent = 'Native menu';
      document.body.append(menu);
      const player = document.querySelector('#movie_player');
      player.addEventListener('contextmenu', event => {
        event.preventDefault();
        menu.style.display = 'block';
      });
      window.nativeDismissals = 0;
      document.addEventListener('click', () => {
        if (menu.style.display !== 'none') {
          nativeDismissals++;
          menu.style.display = 'none';
        }
      });
    }, menuClass);
    const video = page.locator('video');
    const menu = page.locator(`.${menuClass}`);
    for (const paused of [false, true]) {
      assert.equal(await video.evaluate(v => v.paused), paused);
      await video.click({ button: 'right' });
      assert.equal(await menu.isVisible(), true);
      await video.click();
      assert.equal(await menu.isVisible(), false);
      assert.equal(await video.evaluate(v => v.paused), paused);
      // A closed menu must not suppress the next ordinary playback click.
      await video.click();
      assert.equal(await video.evaluate(v => v.paused), !paused);
    }
    assert.equal(await page.evaluate(() => nativeDismissals), 2);
  });
}

test('playback shortcuts preserve typing, native buttons and synthetic clicks', async t => {
  const page = await fixture(t);
  await playTestVideo(page);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'search';
    const editor = document.createElement('div');
    editor.id = 'comment';
    editor.contentEditable = 'true';
    const button = document.createElement('button');
    button.id = 'native-play';
    button.textContent = 'Native pause';
    button.onclick = () => document.querySelector('video').pause();
    document.body.append(input, editor);
    document.querySelector('.ytp-right-controls').append(button);
  });
  await page.locator('#search').fill('a');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#search').inputValue(), 'a ');
  await page.locator('#comment').fill('a');
  await page.keyboard.press('Space');
  assert.match(await page.locator('#comment').innerText(), /^a\s$/);
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'shadow-editor';
    const input = document.createElement('input');
    host.attachShadow({ mode: 'open' }).append(input);
    document.body.append(host);
  });
  await page.locator('#shadow-editor input').fill('a');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#shadow-editor input').inputValue(), 'a ');
  await page.locator('video').evaluate(v => v.click());
  assert.equal(await page.locator('video').evaluate(v => v.paused), false);
  await page.locator('#native-play').focus();
  await page.keyboard.press('Space');
  assert.equal(await page.locator('video').evaluate(v => v.paused), true);
});

test('screenshot downloads a PNG and releases its Blob URL', async t => {
  const page = await fixture(t);
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    const video = document.querySelector('video');
    video.srcObject = canvas.captureStream();
    ctx.fillRect(0, 0, 16, 16);
    await video.play();
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.urls = { created: [], revoked: [] };
    URL.createObjectURL = blob => {
      const url = create(blob);
      window.urls.created.push(url);
      return url;
    };
    URL.revokeObjectURL = url => { window.urls.revoked.push(url); revoke(url); };
  });
  await page.locator(toolbox).hover();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTitle('Screenshot').click()]);
  assert.match(download.suggestedFilename(), /screenshot\.png$/);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.deepEqual([...Buffer.concat(chunks).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  await page.waitForFunction(() => window.urls.revoked.length === 1);
  const urls = await page.evaluate(() => window.urls);
  assert.deepEqual(urls.revoked, urls.created);
});
