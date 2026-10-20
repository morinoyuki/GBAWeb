/**
 * End-to-end tests for GBA Web.
 *
 * Runs a real headless Chromium against the local static server, loads the
 * bundled homebrew demo ROM, and exercises the features that matter:
 * emulation, video output, keyboard/touch input, pause, save states,
 * fast-forward, battery saves, zip loading and persistence across reloads.
 *
 * Usage: node tests/e2e.mjs
 * Requires: playwright + chromium (npx playwright install chromium), pngjs.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { PNG } from 'pngjs';

const PORT = Number(process.env.E2E_PORT) || 5230;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = new URL('..', import.meta.url).pathname;

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail !== '' ? ` — ${detail}` : ''}`);
  }
}

async function stats(page) {
  return page.evaluate(() => window.__gba.stats());
}

async function waitPlaying(page) {
  await page.waitForFunction(() => window.__gba?.stats().playing === true, null, { timeout: 30_000 });
}

async function mgbaScreenshot(page) {
  const base64 = await page.evaluate(() => {
    const bytes = window.__gba.screenshot();
    if (!bytes) return null;
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  if (!base64) return null;
  return PNG.sync.read(Buffer.from(base64, 'base64'));
}

function pixelsEqual(a, b) {
  return Boolean(a && b) && a.width === b.width && a.height === b.height && Buffer.compare(a.data, b.data) === 0;
}

function uniqueColors(png) {
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    colors.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  }
  return colors.size;
}

async function openSettings(page) {
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-dialog[open]');
}

async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

function ensureFixtures() {
  mkdirSync('tests/fixtures', { recursive: true });
  const savPath = 'tests/fixtures/custom.sav';
  if (!existsSync(savPath)) {
    const data = Buffer.alloc(32768);
    data[0] = 0xa5;
    for (let i = 1; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff;
    writeFileSync(savPath, data);
  }
  const zipPath = 'tests/fixtures/demo.zip';
  if (!existsSync(zipPath)) {
    const zipped = zipSync({ 'demo.gba': readFileSync('demo/gba-web-demo.gba') });
    writeFileSync(zipPath, Buffer.from(zipped));
  }
}

async function runDesktop(browser) {
  console.log('\nDesktop');
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto(BASE);
  await page.waitForSelector('#home-view:not(.hidden)');
  await page.waitForTimeout(400);

  check('cross-origin isolated (SharedArrayBuffer available)', await page.evaluate(() => crossOriginIsolated));
  check('engine badge shows mGBA', (await page.textContent('#engine-badge')).toLowerCase().includes('mgba'));
  check(
    'repository link is available on the home page',
    (await page.locator('a[href="https://github.com/morinoyuki/GBAWeb"]').count()) >= 1,
  );

  // ---------------------------------------------------------------- demo
  await page.click('#btn-demo');
  await waitPlaying(page);
  await page.waitForTimeout(1400);

  let s = await stats(page);
  check('bundled demo boots', s.playing && !s.paused, JSON.stringify(s));
  check('emulated frames advance', s.frames > 20, `frames=${s.frames}`);
  check('FPS counter is live', s.fps >= 40 && s.fps <= 78, `fps=${s.fps}`);
  check('audio is running', s.audio === true);

  const frame = await mgbaScreenshot(page);
  check('video output is 240x160', frame?.width === 240 && frame?.height === 160);
  check('video output is not blank', uniqueColors(frame) >= 2, `colors=${uniqueColors(frame)}`);

  const libraryCount = await page.locator('.rom-card').count();
  check('ROM is added to the library', libraryCount >= 1, `cards=${libraryCount}`);

  // ------------------------------------------------------------- keyboard
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(120);
  check('keyboard press reaches the core', (await stats(page)).held.includes('Right'));
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(120);
  check('keyboard release clears input', !(await stats(page)).held.includes('Right'));

  await page.keyboard.down('Backspace');
  await page.waitForTimeout(400);
  await page.keyboard.up('Backspace');
  await page.waitForTimeout(200);
  check('rewind keeps the emulator alive', (await stats(page)).playing === true);

  await page.keyboard.press('p');
  await page.waitForTimeout(200);
  check('P hotkey pauses', (await stats(page)).paused === true);
  await page.keyboard.press('p');
  await page.waitForTimeout(200);
  check('P hotkey resumes', (await stats(page)).paused === false);

  // ----------------------------------------------------------- fast-forward
  const measure = async (speed) => {
    await page.evaluate((value) => window.__gba.setSpeed(value), speed);
    await page.waitForTimeout(250);
    const before = (await stats(page)).frames;
    await page.waitForTimeout(1100);
    return (await stats(page)).frames - before;
  };
  const at1x = await measure(1);
  const at4x = await measure(4);
  check('1× runs at about 60 fps', at1x > 45 && at1x < 95, `frames=${at1x}`);
  check('4× fast-forward really speeds up', at4x > at1x * 2.5, `${at1x} -> ${at4x}`);

  await page.evaluate(() => window.__gba.setSpeed(1));
  await page.keyboard.down('Tab');
  await page.waitForTimeout(150);
  check('holding Tab applies temporary fast-forward', (await stats(page)).emuSpeed === 4, `speed=${(await stats(page)).emuSpeed}`);
  await page.keyboard.up('Tab');
  await page.waitForTimeout(150);
  check('releasing Tab restores speed', (await stats(page)).emuSpeed === 1);

  // ---------------------------------------------------------- key bindings
  await openSettings(page);
  const settingsScroll = await page.evaluate(() => {
    const dialog = document.getElementById('settings-dialog');
    const inner = dialog.querySelector('.dialog-inner');
    return {
      dialog: dialog.scrollHeight > dialog.clientHeight,
      inner: inner.scrollHeight > inner.clientHeight,
    };
  });
  check(
    'settings dialog has only one scroll container',
    !settingsScroll.dialog && !settingsScroll.inner,
    JSON.stringify(settingsScroll),
  );
  const aKeyChip = page.locator(
    '#key-bindings .keybind-row[data-group="buttons"][data-action="A"] [data-rebind]',
  ).first();
  await aKeyChip.click();
  await page.keyboard.press('KeyN');
  await page.waitForTimeout(250);
  check(
    'key binding is saved',
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('gba-web:settings:v1'));
      return Array.isArray(saved?.keyBindings?.buttons?.A) && saved.keyBindings.buttons.A.includes('KeyN');
    }),
  );
  await closeDialog(page);

  await page.keyboard.down('n');
  await page.waitForTimeout(120);
  check('rebound key reaches the core', (await stats(page)).held.includes('A'));
  await page.keyboard.up('n');
  await page.keyboard.down('z');
  await page.waitForTimeout(120);
  check('old key no longer controls A', !(await stats(page)).held.includes('A'));
  await page.keyboard.up('z');

  await openSettings(page);
  await page.click('#btn-reset-keys');
  await page.waitForTimeout(250);
  await closeDialog(page);
  await page.keyboard.down('z');
  await page.waitForTimeout(120);
  check('reset keys restores the default binding', (await stats(page)).held.includes('A'));
  await page.keyboard.up('z');

  // ------------------------------------------------------- pause + states
  await page.click('#btn-pause');
  await page.waitForTimeout(200);
  s = await stats(page);
  check('pause stops the game', s.paused === true);
  check('pause overlay is visible', await page.isVisible('#pause-hint'));

  const frameA = await mgbaScreenshot(page);
  check('save state slot 2', (await page.evaluate(() => window.__gba.saveState(2))) === true);

  await page.evaluate(() => window.__gba.resume());
  await page.waitForTimeout(1200);
  await page.click('#btn-pause');
  await page.waitForTimeout(200);
  const frameB = await mgbaScreenshot(page);
  check('game progressed between screenshots', !pixelsEqual(frameA, frameB));

  check('load state slot 2', (await page.evaluate(() => window.__gba.loadState(2))) === true);
  const frameC = await mgbaScreenshot(page);
  check('save state restores the exact frame', pixelsEqual(frameA, frameC));

  await page.click('#btn-slots');
  await page.waitForTimeout(300);
  check('save state panel opens', await page.isVisible('#states-panel'));
  const slot2 = page.locator('#states-grid .state-card[data-slot="2"]');
  check('slot 2 has a thumbnail', (await slot2.locator('.state-thumb img').count()) === 1);
  check('slot 2 load button is enabled', await slot2.locator('.state-actions button').nth(1).isEnabled());

  const [stateDownload] = await Promise.all([
    page.waitForEvent('download'),
    slot2.locator('.state-actions button').nth(2).click(),
  ]);
  check('state can be exported', stateDownload.suggestedFilename().endsWith('.ss2'), stateDownload.suggestedFilename());
  await stateDownload.saveAs('tests/fixtures/state.ss2');

  await page.click('#btn-slot-next');
  await page.setInputFiles('#state-import-input', 'tests/fixtures/state.ss2');
  await page.waitForTimeout(700);
  const slot3 = page.locator('#states-grid .state-card[data-slot="3"]');
  check('imported state fills the current slot', (await slot3.locator('.state-thumb img').count()) === 1);
  check('imported state can be loaded', await slot3.locator('.state-actions button').nth(1).isEnabled());
  await page.click('#btn-close-states');

  // ------------------------------------------------------ battery save I/O
  // Create a stale crash-recovery state first. The imported .sav must win
  // over it on both the import reload and the next normal page load.
  await page.evaluate(() => window.__gba.resume());
  await page.waitForTimeout(200);
  const forcedStale = await page.evaluate(() => window.__gba.emulator.forceAutoSave());
  check('crash-recovery state exists before .sav import', forcedStale === true);

  await page.setInputFiles('#save-import-input', 'tests/fixtures/custom.sav');
  await page.waitForTimeout(1200);
  await page.waitForFunction(
    () => window.__gba?.stats().playing && document.getElementById('stage-overlay').classList.contains('hidden'),
    null,
    { timeout: 30_000 },
  );
  let saveHead = await page.evaluate(() => Array.from(window.__gba.emulator.getSave().slice(0, 8)));
  check('imported .sav is applied', saveHead[0] === 0xa5, saveHead.join(','));
  check(
    'import removes the stale auto-restore state',
    !(await page.evaluate(() => window.__gba.emulator.hasAutoSave())),
  );

  await openSettings(page);
  check(
    'battery save target names the current game',
    (await page.textContent('#battery-save-target')).includes('GBA Web Demo'),
  );
  const [savDownload] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-save')]);
  check('battery save can be exported', savDownload.suggestedFilename().endsWith('.sav'), savDownload.suggestedFilename());
  await closeDialog(page);

  await page.reload();
  await page.waitForSelector('#home-view:not(.hidden)');
  await page.waitForTimeout(400);

  check('library survives reload', (await page.locator('.rom-card').count()) >= 1);
  check(
    'continue button is offered',
    (await page.locator('#btn-continue').isVisible()) && (await page.textContent('#btn-continue')).toLowerCase().includes('demo'),
  );

  await page.locator('.rom-card').first().locator('.rom-info').click();
  await waitPlaying(page);
  await page.waitForTimeout(900);
  saveHead = await page.evaluate(() => Array.from(window.__gba.emulator.getSave().slice(0, 8)));
  check('battery save persists across reload', saveHead[0] === 0xa5, saveHead.join(','));

  const forcedManual = await page.evaluate(() => window.__gba.emulator.forceAutoSave());
  check('manual auto-save can be captured', forcedManual === true);
  await openSettings(page);
  check('manual auto-save button is enabled', await page.isEnabled('#btn-load-autosave'));
  await page.locator('#btn-load-autosave').scrollIntoViewIfNeeded();
  await page.click('#btn-load-autosave');
  await page.waitForTimeout(500);
  check(
    'manual auto-save can be read',
    (await page.textContent('#toasts')).includes('已读取自动存档'),
  );

  await page.click('#btn-slots');
  await page.waitForTimeout(300);
  check(
    'save states persist across reload',
    (await page.locator('#states-grid .state-card[data-slot="2"] .state-thumb img').count()) === 1,
  );
  check(
    'persisted state can still be loaded',
    await page.locator('#states-grid .state-card[data-slot="2"] .state-actions button').nth(1).isEnabled(),
  );
  await page.click('#btn-close-states');

  // ---------------------------------------------------- home / continue
  await page.click('#btn-home');
  await page.waitForSelector('#home-view:not(.hidden)');
  await page.waitForTimeout(300);
  check('home pauses the running game', (await stats(page)).paused === true);
  await page.click('#btn-continue');
  await waitPlaying(page);
  await page.waitForTimeout(500);
  check('continue resumes the same game', (await stats(page)).paused === false);

  // ------------------------------------------------------------ zip + reset
  await page.setInputFiles('#rom-input', 'tests/fixtures/demo.zip');
  await page.waitForTimeout(400);
  await waitPlaying(page);
  await page.waitForTimeout(900);
  s = await stats(page);
  check('zip archives load', s.playing && /\.gba$/i.test(s.rom || ''), s.rom);

  await openSettings(page);
  await page.click('#btn-reset');
  await page.waitForTimeout(700);
  s = await stats(page);
  check('reset keeps the game running', s.playing && !s.paused && s.frames > 5, JSON.stringify(s));
  await closeDialog(page);

  // ------------------------------------------------------------- fullscreen
  await page.evaluate(async () => {
    await document.getElementById('player-view').requestFullscreen?.();
  });
  await page.waitForTimeout(400);
  check('fullscreen API works', await page.evaluate(() => Boolean(document.fullscreenElement)));

  await page.waitForTimeout(2800);
  check(
    'fullscreen chrome auto-hides',
    await page.evaluate(() => document.getElementById('player-view').classList.contains('chrome-hidden')),
  );
  await page.mouse.move(600, 400);
  await page.waitForTimeout(300);
  check(
    'mouse movement restores the fullscreen chrome',
    !(await page.evaluate(() => document.getElementById('player-view').classList.contains('chrome-hidden'))),
  );

  await page.evaluate(() => document.exitFullscreen?.());
  await page.waitForTimeout(300);

  await page.click('#btn-home');
  await page.waitForSelector('#home-view:not(.hidden)');
  await page.waitForTimeout(300);
  const beforeDelete = await page.locator('.rom-card').count();
  await page.locator('.rom-card').first().hover();
  await page.locator('.rom-card').first().locator('.rom-delete').click();
  await page.waitForTimeout(500);
  check('deleting a ROM clears it from the library', (await page.locator('.rom-card').count()) < beforeDelete);

  await page.click('#btn-demo');
  await waitPlaying(page);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.__beforeClear = 1;
  });
  await openSettings(page);
  await page.click('#btn-clear-all');
  await page.waitForFunction(() => window.__beforeClear === undefined && window.__gba, null, { timeout: 20_000 });
  await page.waitForSelector('#home-view:not(.hidden)');
  await page.waitForTimeout(600);
  check('clear all data empties the library', (await page.locator('.rom-card').count()) === 0);

  check('no page/console errors (desktop)', errors.length === 0, errors.join(' | '));
  await page.close();
}

async function runSaveRegression(browser) {
  console.log('\nIn-game save vs auto-save');
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // save-test.gba writes 0x11 to SRAM at boot, then 0x5A after ~5 seconds.
  await page.goto(BASE);
  await page.setInputFiles('#rom-input', 'tests/fixtures/save-test.gba');
  await waitPlaying(page);
  await page.waitForFunction(() => window.__gba.emulator.getSave()?.[0] === 0x11, null, { timeout: 15_000 });
  check('test ROM writes its initial save', true);

  const forced = await page.evaluate(() => window.__gba.emulator.forceAutoSave());
  check('auto-save captured before the in-game save', forced === true);

  await page.waitForFunction(() => window.__gba.emulator.getSave()?.[0] === 0x5A, null, { timeout: 15_000 });
  const marked = await page.evaluate(() =>
    Object.keys(localStorage).some((key) => key.startsWith('gba-web:autosave-stale:')));
  check('in-game save marks the old auto state stale', marked);

  // Reload right after the save. This models closing the tab immediately:
  // the synchronous marker must make the next load ignore the pre-save state.
  await page.reload();
  await page.waitForSelector('#home-view:not(.hidden)');
  await page.waitForTimeout(250);
  await page.click('#btn-continue');
  await waitPlaying(page);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    head: Array.from(window.__gba.emulator.getSave().slice(0, 2)),
    hasAutoSave: window.__gba.emulator.hasAutoSave(),
  }));
  check('in-game save survives an immediate reload', after.head[0] === 0x5A, after.head.join(','));
  check('pre-save auto state is cleared on load', after.hasAutoSave === false);
  check('no page errors (save vs auto-save)', errors.length === 0, errors.join(' | '));

  await context.close();
}

async function runMobile(browser) {
  console.log('\nMobile');
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(BASE);
  await page.waitForSelector('#home-view:not(.hidden)');
  await page.waitForTimeout(300);
  await page.click('#btn-demo');
  await waitPlaying(page);
  await page.waitForTimeout(700);

  check('touch controls are shown on touch devices', await page.isVisible('#touch-controls'));
  const layout = await page.evaluate(() => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const touch = document.getElementById('touch-controls').getBoundingClientRect();
    return { ratio: stage.width / stage.height, controlsBelow: touch.top >= stage.bottom - 1 };
  });
  check('game screen keeps 3:2 ratio on mobile', Math.abs(layout.ratio - 1.5) < 0.06, `ratio=${layout.ratio.toFixed(3)}`);
  check('touch controls sit below the screen', layout.controlsBelow);

  await page.dispatchEvent('#touch-controls [data-btn="A"]', 'pointerdown', {
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: true,
    bubbles: true,
  });
  await page.waitForTimeout(120);
  check('touch button reaches the core', (await stats(page)).held.includes('A'));
  await page.dispatchEvent('#touch-controls [data-btn="A"]', 'pointerup', {
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: true,
    bubbles: true,
  });
  await page.waitForTimeout(120);
  check('touch release clears input', !(await stats(page)).held.includes('A'));

  check('no page errors (mobile)', errors.length === 0, errors.join(' | '));
  await context.close();
}

async function main() {
  ensureFixtures();
  const server = spawn(process.execPath, ['serve.mjs', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  await sleep(600);

  const browser = await chromium.launch();
  try {
    await runDesktop(browser);
    await runSaveRegression(browser);
    await runMobile(browser);
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
