/**
 * GBA Web — front-end controller.
 *
 * The heavy lifting (CPU/PPU/APU/DMA) is done by the mGBA WASM core. This file
 * owns everything around it: library, persistence, save states, input mapping,
 * speed controls, rewind, and the UI.
 */
import { Emulator } from './emulator.js';
import {
  InputManager,
  DEFAULT_BINDINGS,
  BUTTON_LABELS,
  ACTION_LABELS,
  MAX_KEYS_PER_ACTION,
  isReservedCode,
  keyLabel,
  normalizeBindings,
} from './input.js';
import * as store from './storage.js';
import { readRomFile, formatBytes } from './rom.js';

const SETTINGS_KEY = 'gba-web:settings:v1';
const SLOT_COUNT = 8;
const SPEEDS = [1, 2, 3, 4, 8];

const DEFAULT_SETTINGS = {
  volume: 0.8,
  fastSpeed: 4,
  touch: 'auto',
  integerScale: false,
  showFps: true,
  autoSaveInterval: 60,
  autoRestore: true,
  slot: 1,
  keyBindings: normalizeBindings(DEFAULT_BINDINGS),
};

const $ = (id) => document.getElementById(id);

const els = {};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  emulator: null,
  input: null,
  rom: null,
  playing: false,
  paused: false,
  overlay: false,
  speed: 1,
  holdingFF: false,
  rewinding: false,
  slot: 1,
  autoPaused: false,
  loadToken: 0,
  lastSaveSig: '',
  saveDebounce: null,
  saveTicker: null,
  playStartedAt: 0,
  playAccumMs: 0,
  fps: 0,
  fpsFrames: 0,
  fpsLast: 0,
  lastFrameCount: 0,
  libraryUrls: [],
  stateUrls: [],
  osdTimer: null,
  booted: false,
};

/* ------------------------------------------------------------------ boot */

async function init() {
  cacheElements();
  loadSettings();
  bindUI();
  applySettings();
  updateEngineBadge();

  state.emulator = new Emulator(els.canvas);
  state.emulator.onSaveDataUpdated = () => scheduleSaveCapture();
  state.emulator.onCrash = () => {
    toast('模拟器核心发生错误，游戏已暂停', 'error', 6000);
    if (state.playing) pauseGame();
  };

  state.input = new InputManager({
    bindings: state.settings.keyBindings,
    onPress: (button) => {
      if (state.playing && !state.paused) state.emulator.press(button);
    },
    onRelease: (button) => state.emulator.release(button),
    onAction: handleAction,
    onGamepadConnected: (pad) => toast(`已连接手柄：${pad.id}`, 'ok'),
  });
  state.input.attach();
  buildHelp();

  setupTouchControls();
  setupDragAndDrop();
  setupAudioUnlock();
  setupVisibility();
  setupScreenFit();
  setupPanelsOutsideClick();

  if (!globalThis.crossOriginIsolated) {
    showIsolationBanner();
  }

  await renderLibrary();
  updateContinueButton();

  state.lastFrameCount = 0;
  requestAnimationFrame(tick);

  // Expose a small debug/integration surface (used by the automated tests).
  window.__gba = {
    get ready() {
      return true;
    },
    get emulator() {
      return state.emulator;
    },
    get rom() {
      return state.rom;
    },
    playByHash: async (hash) => {
      const rom = await store.getRom(hash);
      if (rom) await playRom(rom);
    },
    home: goHome,
    pause: pauseGame,
    resume: resumeGame,
    saveState: (slot = state.slot) => writeState(slot),
    loadState: (slot = state.slot) => readState(slot),
    setSpeed,
    stats: () => ({
      version: state.emulator?.version || '',
      rom: state.rom?.name || null,
      playing: state.playing,
      paused: state.paused,
      speed: state.speed,
      emuSpeed: state.emulator?.speed || 1,
      fps: state.fps,
      frames: state.emulator?.frames || 0,
      slot: state.slot,
      audio: state.emulator?.audioReady ?? false,
      held: state.input ? [...state.input.sources.keys()] : [],
    }),
    screenshot: () => state.emulator.screenshot(true),
    library: () => store.listRoms(),
  };
}

function cacheElements() {
  const ids = [
    'home-view',
    'player-view',
    'player-shell',
    'btn-brand',
    'btn-help',
    'btn-settings',
    'btn-open-rom',
    'btn-continue',
    'btn-demo',
    'rom-input',
    'dropzone',
    'library-section',
    'library-grid',
    'library-count',
    'engine-badge',
    'screen',
    'stage',
    'stage-overlay',
    'stage-overlay-text',
    'pause-hint',
    'osd',
    'game-title',
    'hud-fps',
    'hud-speed',
    'hud-audio',
    'btn-home',
    'btn-pause',
    'btn-pause-label',
    'btn-quicksave',
    'btn-quickload',
    'btn-rewind',
    'btn-slots',
    'btn-speed',
    'speed-label',
    'btn-mute',
    'volume',
    'btn-fullscreen',
    'current-slot-pill',
    'states-panel',
    'states-grid',
    'btn-close-states',
    'btn-slot-prev',
    'btn-slot-next',
    'current-slot-label',
    'settings-dialog',
    'help-dialog',
    'help-body',
    'set-speed',
    'set-volume',
    'set-touch',
    'set-integer',
    'set-fps',
    'set-autosave',
    'set-autorestore',
    'key-bindings',
    'keybind-status',
    'btn-reset-keys',
    'battery-save-target',
    'battery-save-hint',
    'states-note',
    'btn-import-state',
    'state-import-input',
    'import-slot-label',
    'btn-export-save',
    'btn-import-save',
    'save-import-input',
    'btn-reset',
    'btn-clear-all',
    'about-engine',
    'toasts',
    'drop-overlay',
    'boot-screen',
    'boot-text',
    'touch-controls',
  ];
  for (const id of ids) els[toCamel(id)] = $(id);
  // Convenience alias: the canvas element is #screen.
  els.canvas = els.screen;
}

function toCamel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/* -------------------------------------------------------------- settings */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const source = parsed && typeof parsed === 'object' ? parsed : {};
      state.settings = { ...DEFAULT_SETTINGS, ...source };
      state.settings.keyBindings = normalizeBindings(source.keyBindings);
    }
  } catch {
    /* ignore corrupt settings */
  }
  state.slot = clamp(state.settings.slot, 1, SLOT_COUNT);
  state.speed = 1;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...state.settings, slot: state.slot }));
  } catch {
    /* storage may be full or disabled */
  }
}

function applySettings() {
  const s = state.settings;

  els.volume.value = String(Math.round(s.volume * 100));
  els.setVolume.value = els.volume.value;
  els.setSpeed.value = String(s.fastSpeed);
  els.setTouch.value = s.touch;
  els.setInteger.checked = Boolean(s.integerScale);
  els.setFps.checked = Boolean(s.showFps);
  els.setAutosave.value = String(s.autoSaveInterval);
  els.setAutorestore.checked = Boolean(s.autoRestore);

  applyTouchMode();
  applyFpsVisibility();
  fitScreen();
  updateVolumeIcon();
  updateSlotUI();
  applyAutoSave();
}

function applyTouchMode() {
  document.body.classList.toggle('touch-auto', state.settings.touch === 'auto');
  const show =
    state.settings.touch === 'on' ||
    (state.settings.touch === 'auto' && window.matchMedia('(pointer: coarse)').matches);
  els.touchControls.classList.toggle('hidden', !show);
}

function applyFpsVisibility() {
  els.hudFps.classList.toggle('hidden', !state.settings.showFps);
}

function applyAutoSave() {
  if (!state.emulator?.ready) return;
  state.emulator.setAutoSave({
    enabled: state.settings.autoSaveInterval > 0,
    intervalSeconds: state.settings.autoSaveInterval || 60,
    restoreOnLoad: state.settings.autoRestore,
  });
}

function setVolume(value) {
  const volume = clamp(Number(value) || 0, 0, 1);
  state.settings.volume = volume;
  state.emulator?.setVolume(volume);
  els.volume.value = String(Math.round(volume * 100));
  els.setVolume.value = els.volume.value;
  updateVolumeIcon();
  saveSettings();
}

function toggleMute() {
  if (state.settings.volume > 0) {
    state.lastVolume = state.settings.volume;
    setVolume(0);
    osd('🔇 已静音');
  } else {
    setVolume(state.lastVolume || 0.8);
    osd('🔊 已恢复音量');
  }
}

function updateVolumeIcon() {
  const use = els.btnMute.querySelector('use');
  use.setAttribute('href', state.settings.volume > 0 ? '#i-volume' : '#i-mute');
}

/* ------------------------------------------------------------------- UI */

function buildHelp() {
  const bindings = state.settings.keyBindings;
  const keysFor = (group, name) => {
    const codes = bindings[group]?.[name] || [];
    return codes.length ? codes.map(keyLabel).join(' / ') : '未绑定';
  };
  const rowsFor = (group, labels) =>
    Object.entries(labels)
      .map(
        ([name, label]) =>
          `<tr><td><kbd>${escapeHtml(keysFor(group, name))}</kbd></td><td>${escapeHtml(label)}</td></tr>`,
      )
      .join('');

  els.helpBody.innerHTML = `
    <h3>键盘 · 游戏按键</h3>
    <table class="kbd-table">${rowsFor('buttons', BUTTON_LABELS)}</table>
    <h3>键盘 · 快捷键</h3>
    <table class="kbd-table">${rowsFor('actions', ACTION_LABELS)}</table>
    <h3>手柄</h3>
    <table class="kbd-table">
      <tr><td>A / B 键</td><td>A / B</td></tr>
      <tr><td>十字键 / 左摇杆</td><td>方向</td></tr>
      <tr><td>L1 / R1、L2 / R2</td><td>L / R</td></tr>
      <tr><td>Start / Back</td><td>Start / Select</td></tr>
    </table>
    <h3>触屏</h3>
    <p class="muted small">在手机或平板上会自动显示虚拟按键，也可以在设置中强制显示。</p>
    <h3>按键自定义</h3>
    <p class="muted small">
      在「设置 → 按键」中点击键位后按下新按键即可重新绑定；同一个按键只能绑定一个动作，
      按 Esc 取消。手柄键位固定。
    </p>
    <h3>存档说明</h3>
    <p class="muted small">
      即时存档保存在浏览器 IndexedDB 中，每个游戏 8 个槽位；电池存档（.sav）会在游戏写入存档时自动保存，
      也可以手动导出/导入。清除浏览器站点数据会同时删除这些存档。
    </p>
    <p class="help-note">
      页面需要 COOP/COEP 响应头（或内置的 coi-serviceworker 兜底）才能启用 WASM 多线程。
      若模拟器无法启动，请检查部署配置（见 README）。
    </p>
  `;
}

/* --------------------------------------------------------- key bindings */

let keyCapture = null;
const KEYBIND_STATUS_DEFAULT = '点击键位后按下新按键，Esc 取消。同一个按键只能绑定一个动作。';

function setKeybindStatus(message) {
  if (els.keybindStatus) els.keybindStatus.textContent = message;
}

function renderKeyBindings() {
  if (!els.keyBindings) return;
  els.keyBindings.replaceChildren();

  const groups = [
    ['buttons', '游戏按键', BUTTON_LABELS],
    ['actions', '快捷键', ACTION_LABELS],
  ];

  for (const [group, title, labels] of groups) {
    const heading = document.createElement('div');
    heading.className = 'keybind-heading';
    heading.textContent = title;
    els.keyBindings.appendChild(heading);

    for (const [name, label] of Object.entries(labels)) {
      const row = document.createElement('div');
      row.className = 'keybind-row';
      row.dataset.group = group;
      row.dataset.action = name;

      const labelEl = document.createElement('span');
      labelEl.className = 'keybind-label';
      labelEl.textContent = label;

      const chips = document.createElement('div');
      chips.className = 'key-chips';
      const codes = state.settings.keyBindings[group][name] || [];

      codes.forEach((code, index) => {
        const chip = document.createElement('span');
        chip.className = 'key-chip';

        const rebind = document.createElement('button');
        rebind.type = 'button';
        rebind.className = 'key-rebind';
        rebind.dataset.rebind = code;
        rebind.textContent = keyLabel(code);
        rebind.title = '点击后按新按键';
        rebind.addEventListener('click', () => beginKeyCapture(group, name, index));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'key-remove';
        remove.dataset.remove = code;
        remove.textContent = '×';
        remove.title = '移除这个键位';
        remove.addEventListener('click', () => removeKeyBinding(group, name, code));

        chip.append(rebind, remove);
        chips.appendChild(chip);
      });

      if (!codes.length) {
        const none = document.createElement('span');
        none.className = 'key-none';
        none.textContent = '未绑定';
        chips.appendChild(none);
      }

      row.append(labelEl, chips);

      if (codes.length < MAX_KEYS_PER_ACTION) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'key-add';
        add.textContent = '+';
        add.title = '添加一个键位';
        add.addEventListener('click', () => beginKeyCapture(group, name, -1));
        row.appendChild(add);
      }

      els.keyBindings.appendChild(row);
    }
  }
}

function cancelKeyCapture() {
  if (!keyCapture) return;
  window.removeEventListener('keydown', keyCapture.handler, true);
  const row = els.keyBindings?.querySelector(
    `.keybind-row[data-group="${keyCapture.group}"][data-action="${keyCapture.name}"]`,
  );
  row?.classList.remove('capturing');
  keyCapture = null;
  setKeybindStatus(KEYBIND_STATUS_DEFAULT);
}

function beginKeyCapture(group, name, index) {
  cancelKeyCapture();
  const actionLabel = (group === 'buttons' ? BUTTON_LABELS : ACTION_LABELS)[name] || name;

  const handler = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.code === 'Escape') {
      cancelKeyCapture();
      return;
    }
    if (isReservedCode(event.code)) {
      setKeybindStatus(`「${keyLabel(event.code)}」不能用作游戏键位，请换一个。`);
      return;
    }
    applyKeyBinding(group, name, index, event.code);
  };

  keyCapture = { group, name, index, handler };
  window.addEventListener('keydown', handler, true);
  const row = els.keyBindings?.querySelector(
    `.keybind-row[data-group="${group}"][data-action="${name}"]`,
  );
  row?.classList.add('capturing');
  setKeybindStatus(`请按下要绑定到「${actionLabel}」的按键（Esc 取消）`);
}

function applyKeyBinding(group, name, index, code) {
  const oldCode = index >= 0 ? state.settings.keyBindings[group][name][index] : null;

  // One physical key should map to exactly one action.
  for (const g of ['buttons', 'actions']) {
    const labels = g === 'buttons' ? BUTTON_LABELS : ACTION_LABELS;
    for (const key of Object.keys(labels)) {
      state.settings.keyBindings[g][key] = state.settings.keyBindings[g][key].filter((c) => c !== code);
    }
  }

  const target = state.settings.keyBindings[group][name];
  if (oldCode && target.includes(oldCode)) {
    target[target.indexOf(oldCode)] = code;
  } else if (index >= 0) {
    target.splice(Math.min(index, target.length), 0, code);
  } else {
    target.push(code);
  }
  if (target.length > MAX_KEYS_PER_ACTION) target.length = MAX_KEYS_PER_ACTION;

  state.settings.keyBindings = normalizeBindings(state.settings.keyBindings);
  state.input.setBindings(state.settings.keyBindings);
  saveSettings();
  cancelKeyCapture();
  renderKeyBindings();
  buildHelp();

  const label = (group === 'buttons' ? BUTTON_LABELS : ACTION_LABELS)[name] || name;
  setKeybindStatus(`已把「${label}」绑定到 ${keyLabel(code)}`);
  toast(`「${label}」→ ${keyLabel(code)}`, 'ok');
}

function removeKeyBinding(group, name, code) {
  state.settings.keyBindings[group][name] = state.settings.keyBindings[group][name].filter(
    (c) => c !== code,
  );
  state.input.setBindings(state.settings.keyBindings);
  saveSettings();
  renderKeyBindings();
  buildHelp();
  setKeybindStatus(`已移除键位 ${keyLabel(code)}`);
}

function resetKeyBindings() {
  state.settings.keyBindings = normalizeBindings(DEFAULT_BINDINGS);
  state.input.setBindings(state.settings.keyBindings);
  saveSettings();
  renderKeyBindings();
  buildHelp();
  setKeybindStatus('已恢复默认键位。');
  toast('已恢复默认键位', 'ok');
}

function showView(name) {
  const player = name === 'player';
  els.homeView.classList.toggle('hidden', player);
  els.playerView.classList.toggle('hidden', !player);
  document.body.classList.toggle('in-game', player);
  if (player) fitScreen();
}

function setOverlay(text) {
  state.overlay = Boolean(text);
  els.stageOverlay.classList.toggle('hidden', !text);
  if (text) els.stageOverlayText.textContent = text;
}

function setPauseHint(visible) {
  els.pauseHint.classList.toggle('hidden', !visible);
}

function osd(message, duration = 1600) {
  els.osd.textContent = message;
  els.osd.classList.add('show');
  clearTimeout(state.osdTimer);
  state.osdTimer = setTimeout(() => els.osd.classList.remove('show'), duration);
}

function toast(message, type = '', duration = 3200) {
  const node = document.createElement('div');
  node.className = `toast ${type}`.trim();
  node.textContent = message;
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, duration);
  return node;
}

function updateEngineBadge() {
  const version = state.emulator?.version;
  if (version) {
    els.engineBadge.textContent = version.replace(/\s+/g, ' ');
    els.engineBadge.title = `${version} · WebAssembly`;
    els.aboutEngine.textContent = version;
  }
}

function showIsolationBanner() {
  const banner = document.createElement('div');
  banner.className = 'isolation-banner';
  banner.innerHTML =
    '⚠️ 当前页面未启用 <b>COOP/COEP</b> 响应头，SharedArrayBuffer 不可用，模拟器可能无法启动。' +
    ' 请使用 <code>node serve.mjs</code> 或按 README 配置服务器。';
  els.homeView.prepend(banner);
}

function updateGameUI() {
  els.gameTitle.textContent = state.rom?.name || '—';
  els.gameTitle.title = state.rom?.name || '';
  els.hudSpeed.textContent = `${state.speed}×`;
  els.speedLabel.textContent = `${state.speed}×`;
  els.currentSlotPill.textContent = String(state.slot);
  updatePauseUI();
  updateStats();
}

function updatePauseUI() {
  els.pauseHint.classList.toggle('hidden', !(state.playing && state.paused));
  els.btnPauseLabel.textContent = state.paused ? '继续' : '暂停';
  els.btnPause.querySelector('use').setAttribute('href', state.paused ? '#i-play' : '#i-pause');
  els.btnPause.classList.toggle('active', state.paused);
}

function updateStats() {
  els.hudFps.textContent = `${state.fps || 0} FPS`;
  els.hudSpeed.textContent = `${state.holdingFF ? state.settings.fastSpeed : state.speed}×`;
  els.hudAudio.textContent = state.emulator?.audioReady ? '音频 ✓' : '音频 —';
}

function updateSlotUI() {
  els.currentSlotPill.textContent = String(state.slot);
  els.currentSlotLabel.textContent = String(state.slot);
  if (els.importSlotLabel) els.importSlotLabel.textContent = String(state.slot);
  for (const card of els.statesGrid.querySelectorAll('.state-card')) {
    card.classList.toggle('current', Number(card.dataset.slot) === state.slot);
  }
}

/* ------------------------------------------------------------- library */

async function renderLibrary() {
  let roms = [];
  try {
    roms = await store.listRoms();
  } catch (err) {
    console.error(err);
    toast('无法读取本地游戏库：' + (err.message || err), 'error');
  }

  for (const url of state.libraryUrls) URL.revokeObjectURL(url);
  state.libraryUrls = [];
  els.libraryGrid.replaceChildren();

  const hasRoms = roms.length > 0;
  els.librarySection.classList.toggle('hidden', !hasRoms);
  els.libraryCount.textContent = hasRoms ? `${roms.length} 个游戏` : '';

  for (const rom of roms) {
    const card = document.createElement('article');
    card.className = 'rom-card';

    const thumbBtn = document.createElement('button');
    thumbBtn.className = 'rom-thumb-btn';
    thumbBtn.type = 'button';
    thumbBtn.title = `游玩 ${rom.name}`;
    if (rom.thumb) {
      const url = URL.createObjectURL(new Blob([rom.thumb], { type: 'image/png' }));
      state.libraryUrls.push(url);
      const img = document.createElement('img');
      img.className = 'rom-thumb';
      img.alt = '';
      img.src = url;
      thumbBtn.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'rom-thumb placeholder';
      ph.innerHTML = '<svg><use href="#i-chip" /></svg>';
      thumbBtn.appendChild(ph);
    }
    thumbBtn.addEventListener('click', () => openLibraryRom(rom));

    const info = document.createElement('div');
    info.className = 'rom-info';
    info.tabIndex = 0;
    info.addEventListener('click', () => openLibraryRom(rom));
    info.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openLibraryRom(rom);
      }
    });

    const name = document.createElement('div');
    name.className = 'rom-name';
    name.textContent = rom.name;
    name.title = rom.name;

    const meta = document.createElement('div');
    meta.className = 'rom-meta';
    const played = rom.lastPlayedAt ? `上次游玩 ${timeAgo(rom.lastPlayedAt)}` : '尚未游玩';
    const playedFor = rom.playtimeMs ? ` · 已玩 ${formatDuration(rom.playtimeMs)}` : '';
    meta.textContent = `${formatBytes(rom.size)} · ${played}${playedFor}`;

    info.append(name, meta);

    const del = document.createElement('button');
    del.className = 'icon-btn rom-delete';
    del.type = 'button';
    del.title = '删除此游戏及其存档';
    del.innerHTML = '<svg><use href="#i-trash" /></svg>';
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      await removeRom(rom);
    });

    card.append(thumbBtn, info, del);
    els.libraryGrid.appendChild(card);
  }
}

async function updateContinueButton() {
  try {
    const lastHash = await store.getMeta('lastRom');
    const rom = lastHash ? await store.getRomMeta(lastHash) : null;
    els.btnContinue.classList.toggle('hidden', !rom);
    if (rom) {
      els.btnContinue.title = `继续游玩 ${rom.name}`;
      els.btnContinue.dataset.hash = rom.hash;
      els.btnContinue.innerHTML = '<svg><use href="#i-load" /></svg>';
      els.btnContinue.append(document.createTextNode(`继续《${truncate(rom.name, 24)}》`));
    }
  } catch {
    els.btnContinue.classList.add('hidden');
  }
}

async function removeRom(rom) {
  const confirmed = window.confirm(`删除《${rom.name}》以及它的电池存档和即时存档？`);
  if (!confirmed) return;
  try {
    if (state.rom?.hash === rom.hash) {
      await captureBatterySave();
      state.emulator.unload();
      state.playing = false;
      state.rom = null;
      goHome();
    }
    await store.deleteRom(rom.hash);
    await state.emulator.removeRomFiles(rom.name);
    await renderLibrary();
    await updateContinueButton();
    toast('已删除游戏数据', 'ok');
  } catch (err) {
    toast('删除失败：' + (err.message || err), 'error');
  }
}

/* ------------------------------------------------------------- ROM load */

async function loadBundledDemo() {
  try {
    const response = await fetch('./demo/gba-web-demo.gba');
    if (!response.ok) throw new Error('内置演示文件不可用');
    const blob = await response.blob();
    const file = new File([blob], 'GBA Web Demo.gba', { type: 'application/octet-stream' });
    await openRomFile(file);
  } catch (err) {
    console.error(err);
    toast('无法载入内置演示：' + (err.message || err), 'error');
  }
}

async function openRomFile(file) {
  if (!file) return;
  try {
    const info = await readRomFile(file);
    for (const warning of info.warnings) toast(warning, '', 5200);

    const existing = await store.getRomMeta(info.hash);
    const record = {
      hash: info.hash,
      name: info.name,
      size: info.size,
      bytes: toArrayBuffer(info.bytes),
      addedAt: existing?.addedAt ?? Date.now(),
      lastPlayedAt: existing?.lastPlayedAt ?? 0,
      playtimeMs: existing?.playtimeMs ?? 0,
      thumb: existing?.thumb ?? null,
    };
    await store.putRom(record);
    await renderLibrary();
    await updateContinueButton();
    await playRom(record);
  } catch (err) {
    console.error(err);
    toast(err.message || '读取 ROM 失败', 'error', 5000);
  }
}

async function openLibraryRom(meta) {
  try {
    const rom = await store.getRom(meta.hash);
    if (!rom?.bytes) {
      toast('找不到这个 ROM 的数据，请重新载入文件', 'error');
      return;
    }
    await playRom(rom);
  } catch (err) {
    console.error(err);
    toast('载入失败：' + (err.message || err), 'error');
  }
}

async function playRom(rom) {
  if (!rom) return;
  if (!globalThis.crossOriginIsolated) {
    toast('无法启动：页面缺少 COOP/COEP 响应头。请使用 node serve.mjs，或按 README 配置服务器。', 'error', 9000);
    return;
  }
  const token = ++state.loadToken;

  const sameRom = state.rom?.hash === rom.hash && state.emulator?.loaded;
  if (sameRom) {
    showView('player');
    state.playing = true;
    state.rom = rom;
    if (state.paused) await resumeGame();
    updateGameUI();
    await renderStates();
    startSaveTicker();
    return;
  }

  showView('player');
  setPauseHint(false);
  setOverlay('正在启动模拟器…');

  try {
    if (!state.emulator.ready) {
      els.bootScreen.classList.remove('hidden');
      els.bootText.textContent = '正在初始化模拟器核心…';
      await state.emulator.boot();
      els.bootScreen.classList.add('hidden');
      state.booted = true;
      updateEngineBadge();
      applyAutoSave();
    }

    // Persist the previous game before switching.
    if (state.rom && state.rom.hash !== rom.hash) {
      state.emulator.releaseAll();
      await captureBatterySave();
      await captureThumbnail();
      state.playing = false;
    }

    setOverlay(`正在载入 ${rom.name}…`);
    const saveRec = await store.getSave(rom.hash);
    if (token !== state.loadToken) return;

    await state.emulator.loadRom({
      name: rom.name,
      bytes: new Uint8Array(rom.bytes),
      saveBytes: saveRec ? new Uint8Array(saveRec.bytes) : null,
      hash: rom.hash,
    });
    if (token !== state.loadToken) return;

    state.rom = rom;
    state.playing = true;
    state.paused = false;
    state.autoPaused = false;
    state.speed = 1;
    state.emulator.setSpeed(1);
    state.holdingFF = false;
    state.rewinding = false;
    state.playStartedAt = performance.now();
    state.playAccumMs = rom.playtimeMs || 0;
    state.lastSaveSig = quickSignature(state.emulator.getSave());
    state.lastFrameCount = state.emulator.frames;

    state.input.setEnabled(true);
    applyAutoSave();
    state.emulator.setVolume(state.settings.volume);

    await store.updateRom(rom.hash, { lastPlayedAt: Date.now() });
    await store.setMeta('lastRom', rom.hash);
    rom.lastPlayedAt = Date.now();

    setOverlay(null);
    updateGameUI();
    await renderStates();
    startSaveTicker();
    await updateContinueButton();

    toast(`已载入《${rom.name}》`, 'ok');
    scheduleSaveCapture(1500);
  } catch (err) {
    console.error(err);
    setOverlay(null);
    els.bootScreen.classList.add('hidden');
    toast(err.message || '无法启动模拟器', 'error', 6000);
    state.emulator.unload();
    state.playing = false;
    state.rom = null;
    goHome();
  }
}

async function goHome() {
  if (state.playing) {
    await captureBatterySave();
    await captureThumbnail();
    await persistPlaytime();
    state.emulator.pause();
    state.emulator.releaseAll();
    state.input.setEnabled(false);
    state.playing = false;
    state.paused = true;
    state.playStartedAt = 0;
    stopSaveTicker();
  }
  setPauseHint(false);
  closeStatesPanel();
  showView('home');
  await renderLibrary();
  await updateContinueButton();
}

/* -------------------------------------------------------- pause / speed */

function togglePause() {
  if (!state.playing) return;
  if (state.paused) resumeGame();
  else pauseGame();
}

function pauseGame() {
  if (!state.playing || state.paused) return;
  state.emulator.pause();
  state.paused = true;
  state.playStartedAt = 0;
  state.input.setEnabled(false);
  state.emulator.releaseAll();
  updatePauseUI();
  scheduleSaveCapture(200);
}

async function resumeGame() {
  if (!state.playing || !state.paused) return;
  await state.emulator.resume();
  state.paused = false;
  state.autoPaused = false;
  state.playStartedAt = performance.now();
  state.input.setEnabled(true);
  updatePauseUI();
}

function setSpeed(multiplier) {
  const value = SPEEDS.includes(multiplier) ? multiplier : clamp(Math.round(multiplier) || 1, 1, 8);
  state.speed = value;
  state.emulator.setSpeed(value);
  els.speedLabel.textContent = `${value}×`;
  els.hudSpeed.textContent = `${value}×`;
  saveSettings();
  osd(`加速 ${value}×`);
}

function cycleSpeed() {
  const index = SPEEDS.indexOf(state.speed);
  setSpeed(SPEEDS[(index + 1) % SPEEDS.length]);
}

function beginFastForward() {
  if (!state.playing || state.paused || state.holdingFF) return;
  state.holdingFF = true;
  state.emulator.setSpeed(state.settings.fastSpeed);
  els.hudSpeed.textContent = `${state.settings.fastSpeed}×`;
  els.btnSpeed.classList.add('active');
  osd(`加速 ${state.settings.fastSpeed}×`);
}

function endFastForward() {
  if (!state.holdingFF) return;
  state.holdingFF = false;
  state.emulator.setSpeed(state.speed);
  els.hudSpeed.textContent = `${state.speed}×`;
  els.btnSpeed.classList.remove('active');
}

function beginRewind() {
  if (!state.playing || state.paused || state.rewinding) return;
  state.rewinding = true;
  state.emulator.rewind(true);
  els.btnRewind.classList.add('active');
  osd('⏪ 倒带中…', 1200);
}

function endRewind() {
  if (!state.rewinding) return;
  state.rewinding = false;
  state.emulator.rewind(false);
  els.btnRewind.classList.remove('active');
}

/* ------------------------------------------------------------ save states */

function setSlot(slot) {
  state.slot = ((Number(slot) - 1 + SLOT_COUNT) % SLOT_COUNT) + 1;
  state.settings.slot = state.slot;
  saveSettings();
  updateSlotUI();
  osd(`当前槽位 ${state.slot}`);
}

function changeSlot(delta) {
  setSlot(state.slot + delta);
}

async function writeState(slot = state.slot) {
  if (!state.playing || !state.rom) {
    toast('请先载入游戏', '');
    return false;
  }

  try {
    // mGBA can interrupt a paused core safely, so no resume/pause dance is
    // needed here; saving while paused keeps the captured state exact.
    const result = state.emulator.saveState(slot);

    if (!result) {
      toast('保存状态失败', 'error');
      return false;
    }

    await store.putState({
      hash: state.rom.hash,
      slot,
      bytes: result.bytes,
      thumb: result.thumb,
      createdAt: Date.now(),
    });

    setSlot(slot);
    await renderStates();
    toast(`已保存到槽位 ${slot}`, 'ok');
    osd(`💾 已保存到槽位 ${slot}`);
    return true;
  } catch (err) {
    console.error(err);
    toast('保存状态失败：' + (err.message || err), 'error');
    return false;
  }
}

async function readState(slot = state.slot) {
  if (!state.playing || !state.rom) {
    toast('请先载入游戏', '');
    return false;
  }
  try {
    const record = await store.getState(state.rom.hash, slot);
    if (!record) {
      toast(`槽位 ${slot} 还没有存档`, '');
      osd(`槽位 ${slot} 为空`);
      return false;
    }

    const ok = state.emulator.loadState(slot, new Uint8Array(record.bytes));

    if (!ok) {
      toast('读取失败：存档与当前游戏不匹配', 'error');
      return false;
    }

    setSlot(slot);
    if (!state.paused) scheduleSaveCapture(400);
    toast(`已读取槽位 ${slot}`, 'ok');
    osd(`📂 已读取槽位 ${slot}`);
    await renderStates();
    return true;
  } catch (err) {
    console.error(err);
    toast('读取状态失败：' + (err.message || err), 'error');
    return false;
  }
}

async function deleteState(slot) {
  if (!state.rom) return;
  const confirmed = window.confirm(`删除槽位 ${slot} 的即时存档？`);
  if (!confirmed) return;
  await store.deleteState(state.rom.hash, slot);
  state.emulator.deleteStateFile(slot);
  await renderStates();
  toast(`已删除槽位 ${slot}`, 'ok');
}

async function exportState(slot) {
  if (!state.rom) return;
  const record = await store.getState(state.rom.hash, slot);
  if (!record) return;
  downloadBlob(new Blob([record.bytes], { type: 'application/octet-stream' }), `${baseNameOf(state.rom.name)}.ss${slot}`);
  toast(`已导出《${state.rom.name}》槽位 ${slot} 的即时存档`, 'ok');
}

function isMgbaStateFile(bytes) {
  if (!bytes || bytes.length < 64) return false;
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!png.every((value, index) => bytes[index] === value)) return false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length =
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0;
    if (length > bytes.length - offset - 12) return false;
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (type === 'gbAs') return true;
    offset += 12 + length;
  }
  return false;
}

async function importStateFile(file) {
  if (!state.rom) {
    toast('请先载入游戏');
    return;
  }
  if (file.size > 16 * 1024 * 1024) {
    toast('文件太大，不像是 GBA 即时存档', 'error');
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isMgbaStateFile(bytes)) {
    toast('不是有效的 mGBA 即时存档（需要包含 gbAs 数据块的 PNG）', 'error', 6000);
    return;
  }
  const slot = state.slot;
  const existing = await store.getState(state.rom.hash, slot);
  if (existing && !window.confirm(`《${state.rom.name}》槽位 ${slot} 已有存档，覆盖？`)) return;
  await store.putState({
    hash: state.rom.hash,
    slot,
    bytes,
    thumb: bytes,
    createdAt: Date.now(),
  });
  await renderStates();
  updateStatesTargetUI();
  toast(`已导入《${state.rom.name}》的存档到槽位 ${slot}`, 'ok');
  osd(`📂 已导入存档到槽位 ${slot}`);
}

async function renderStates() {
  updateStatesTargetUI();
  for (const url of state.stateUrls) URL.revokeObjectURL(url);
  state.stateUrls = [];
  els.statesGrid.replaceChildren();

  if (!state.rom) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = '载入游戏后可以在这里保存/读取即时存档。';
    els.statesGrid.appendChild(empty);
    return;
  }

  let states = [];
  try {
    states = await store.listStates(state.rom.hash);
  } catch (err) {
    console.error(err);
  }
  const bySlot = new Map(states.map((s) => [s.slot, s]));

  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const record = bySlot.get(slot);
    const card = document.createElement('article');
    card.className = 'state-card';
    card.dataset.slot = String(slot);
    if (slot === state.slot) card.classList.add('current');

    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'state-thumb';
    thumb.title = record ? `读取槽位 ${slot}` : `保存到槽位 ${slot}`;

    if (record?.thumb) {
      const url = URL.createObjectURL(new Blob([record.thumb], { type: 'image/png' }));
      state.stateUrls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.alt = `槽位 ${slot}`;
      thumb.appendChild(img);
    } else {
      const empty = document.createElement('span');
      empty.className = 'empty';
      empty.innerHTML = `<svg><use href="#i-save" /></svg>${record ? '无缩略图' : '空槽位'}`;
      thumb.appendChild(empty);
    }
    thumb.addEventListener('click', () => {
      if (record) readState(slot);
      else writeState(slot);
    });

    const body = document.createElement('div');
    body.className = 'state-body';

    const line = document.createElement('div');
    line.className = 'state-line';
    const slotLabel = document.createElement('span');
    slotLabel.className = 'state-slot';
    slotLabel.textContent = `槽位 ${slot}`;
    const time = document.createElement('span');
    time.className = 'state-time';
    time.textContent = record ? formatDate(record.createdAt) : '—';
    line.append(slotLabel, time);

    const actions = document.createElement('div');
    actions.className = 'state-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn tiny';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', () => writeState(slot));

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'btn tiny';
    loadBtn.textContent = '读取';
    loadBtn.disabled = !record;
    loadBtn.style.opacity = record ? '1' : '0.45';
    loadBtn.addEventListener('click', () => record && readState(slot));

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'icon-btn';
    exportBtn.title = '导出此存档';
    exportBtn.innerHTML = '<svg><use href="#i-download" /></svg>';
    exportBtn.disabled = !record;
    exportBtn.style.opacity = record ? '1' : '0.35';
    exportBtn.addEventListener('click', () => record && exportState(slot));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn';
    delBtn.title = '删除此存档';
    delBtn.innerHTML = '<svg><use href="#i-trash" /></svg>';
    delBtn.disabled = !record;
    delBtn.style.opacity = record ? '1' : '0.35';
    delBtn.addEventListener('click', () => record && deleteState(slot));

    actions.append(saveBtn, loadBtn, exportBtn, delBtn);
    body.append(line, actions);
    card.append(thumb, body);
    els.statesGrid.appendChild(card);
  }

  updateSlotUI();
}

function updateStatesTargetUI() {
  if (els.statesNote) {
    els.statesNote.textContent = state.rom
      ? `当前游戏：《${state.rom.name}》`
      : '载入游戏后可以保存/读取即时存档。';
  }
  if (els.importSlotLabel) els.importSlotLabel.textContent = String(state.slot);
  if (els.btnImportState) els.btnImportState.disabled = !state.rom;
}

function openStatesPanel() {
  if (!state.rom) {
    toast('请先载入游戏');
    return;
  }
  els.statesPanel.classList.remove('hidden');
  updateStatesTargetUI();
  renderStates();
}

function closeStatesPanel() {
  els.statesPanel.classList.add('hidden');
}

function toggleStatesPanel() {
  if (els.statesPanel.classList.contains('hidden')) openStatesPanel();
  else closeStatesPanel();
}

/* ---------------------------------------------------------- battery saves */

function quickSignature(bytes) {
  if (!bytes || !bytes.length) return '';
  // Full FNV-1a over the (at most 128 KiB) save data. Cheap and catches writes
  // anywhere in the save, not just at sampled offsets.
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash = Math.imul(hash ^ bytes[i], 16777619);
  }
  return `${bytes.length}:${hash >>> 0}`;
}

function scheduleSaveCapture(delay = 600) {
  clearTimeout(state.saveDebounce);
  state.saveDebounce = setTimeout(() => {
    captureBatterySave().catch((err) => console.warn('save capture failed', err));
  }, delay);
}

async function captureBatterySave() {
  if (!state.emulator?.loaded || !state.rom) return false;
  const bytes = state.emulator.getSave();
  if (!bytes || !bytes.length) return false;
  const sig = quickSignature(bytes);
  if (sig === state.lastSaveSig) return false;
  state.lastSaveSig = sig;
  await store.putSave(state.rom.hash, bytes);
  return true;
}

async function exportBatterySave() {
  if (!state.rom) {
    toast('请先载入游戏');
    return;
  }
  let bytes = state.emulator.getSave();
  if (!bytes || !bytes.length) {
    const stored = await store.getSave(state.rom.hash);
    bytes = stored ? new Uint8Array(stored.bytes) : null;
  }
  if (!bytes || !bytes.length) {
    toast('当前游戏还没有电池存档', '');
    return;
  }
  downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `${baseNameOf(state.rom.name)}.sav`);
  toast(`已导出《${state.rom.name}》的电池存档`, 'ok');
}

async function importBatterySave(file) {
  if (!file) return;
  if (!state.rom) {
    toast('请先载入游戏');
    return;
  }
  if (!window.confirm(`将 .sav 导入到《${state.rom.name}》，覆盖当前电池存档？`)) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await store.putSave(state.rom.hash, bytes);
    state.emulator.writeSave(bytes);
    state.lastSaveSig = quickSignature(bytes);
    // Reload the ROM so the core picks up the imported save.
    const rom = state.rom;
    state.emulator.unload();
    state.playing = false;
    state.rom = null;
    await playRom(rom);
    toast(`已导入《${rom.name}》的电池存档`, 'ok');
  } catch (err) {
    toast('导入失败：' + (err.message || err), 'error');
  }
}

async function captureThumbnail() {
  if (!state.emulator?.loaded || !state.rom) return;
  const png = state.emulator.screenshot(true);
  if (!png) return;
  state.rom.thumb = toArrayBuffer(png);
  try {
    await store.updateRom(state.rom.hash, { thumb: toArrayBuffer(png) });
  } catch (err) {
    console.warn('thumbnail save failed', err);
  }
}

async function persistPlaytime() {
  if (!state.rom) return;
  try {
    await store.updateRom(state.rom.hash, { playtimeMs: Math.round(state.playAccumMs) });
  } catch {
    /* ignore */
  }
}

function startSaveTicker() {
  stopSaveTicker();
  state.saveTicker = setInterval(() => {
    if (state.playing && !state.paused) {
      captureBatterySave().catch(() => {});
      persistPlaytime().catch(() => {});
    }
  }, 10_000);
}

function stopSaveTicker() {
  if (state.saveTicker) {
    clearInterval(state.saveTicker);
    state.saveTicker = null;
  }
}

/* --------------------------------------------------------------- actions */

function handleAction(action, phase) {
  switch (action) {
    case 'pause':
      if (state.playing) togglePause();
      break;
    case 'fastForward':
      if (phase === 'start') beginFastForward();
      else endFastForward();
      break;
    case 'rewind':
      if (phase === 'start') beginRewind();
      else endRewind();
      break;
    case 'quickSave':
      if (state.playing) writeState(state.slot);
      break;
    case 'quickLoad':
      if (state.playing) readState(state.slot);
      break;
    case 'slotPrev':
      changeSlot(-1);
      if (!els.statesPanel.classList.contains('hidden')) renderStates();
      break;
    case 'slotNext':
      changeSlot(1);
      if (!els.statesPanel.classList.contains('hidden')) renderStates();
      break;
    case 'mute':
      toggleMute();
      break;
    case 'fullscreen':
      toggleFullscreen();
      break;
    case 'states':
      if (state.playing) toggleStatesPanel();
      break;
    case 'help':
      openHelp();
      break;
    case 'settings':
      openSettings();
      break;
    default:
      break;
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else if (state.playing) {
    els.playerView.requestFullscreen?.().catch(() => toast('无法进入全屏', 'error'));
  }
}

function openHelp() {
  state.input?.setEnabled(false);
  els.helpDialog.showModal();
}

function updateSaveTargetUI() {
  const rom = state.rom;
  if (els.batterySaveTarget) {
    els.batterySaveTarget.textContent = rom ? `《${rom.name}》` : '未载入游戏';
    els.batterySaveTarget.title = rom?.name || '';
  }
  const disabled = !rom;
  if (els.btnExportSave) els.btnExportSave.disabled = disabled;
  if (els.btnImportSave) els.btnImportSave.disabled = disabled;
  if (els.batterySaveHint) {
    els.batterySaveHint.textContent = rom
      ? `导出文件名：${baseNameOf(rom.name)}.sav。导入会覆盖《${rom.name}》的电池存档。`
      : '请先载入游戏，再导出或导入电池存档。';
  }
}

function openSettings() {
  // Refresh the values shown in the dialog.
  els.setSpeed.value = String(state.settings.fastSpeed);
  els.setVolume.value = String(Math.round(state.settings.volume * 100));
  els.setTouch.value = state.settings.touch;
  els.setInteger.checked = Boolean(state.settings.integerScale);
  els.setFps.checked = Boolean(state.settings.showFps);
  els.setAutosave.value = String(state.settings.autoSaveInterval);
  els.setAutorestore.checked = Boolean(state.settings.autoRestore);
  cancelKeyCapture();
  renderKeyBindings();
  setKeybindStatus(KEYBIND_STATUS_DEFAULT);
  updateSaveTargetUI();
  state.input?.setEnabled(false);
  els.settingsDialog.showModal();
}

/* --------------------------------------------------------------- binding */

function bindUI() {
  $('btn-open-rom').addEventListener('click', () => els.romInput.click());
  els.dropzone.addEventListener('click', () => els.romInput.click());
  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.romInput.click();
    }
  });

  els.romInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) openRomFile(file);
    event.target.value = '';
  });

  els.btnContinue.addEventListener('click', async () => {
    const hash = els.btnContinue.dataset.hash;
    const rom = hash ? await store.getRom(hash) : null;
    if (rom) playRom(rom);
  });

  els.btnDemo.addEventListener('click', loadBundledDemo);

  els.btnBrand.addEventListener('click', goHome);
  els.btnHome.addEventListener('click', goHome);
  els.btnPause.addEventListener('click', togglePause);
  els.pauseHint.addEventListener('click', resumeGame);

  els.btnQuicksave.addEventListener('click', () => writeState(state.slot));
  els.btnQuickload.addEventListener('click', () => readState(state.slot));
  els.btnSlots.addEventListener('click', toggleStatesPanel);
  els.btnCloseStates.addEventListener('click', closeStatesPanel);
  els.btnSlotPrev.addEventListener('click', () => changeSlot(-1));
  els.btnSlotNext.addEventListener('click', () => changeSlot(1));
  els.btnSpeed.addEventListener('click', cycleSpeed);
  els.btnFullscreen.addEventListener('click', toggleFullscreen);
  els.btnMute.addEventListener('click', toggleMute);

  els.btnRewind.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    try {
      els.btnRewind.setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
    beginRewind();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    els.btnRewind.addEventListener(type, endRewind);
  }

  els.volume.addEventListener('input', () => setVolume(Number(els.volume.value) / 100));

  els.btnHelp.addEventListener('click', openHelp);
  els.btnSettings.addEventListener('click', openSettings);

  // Settings
  els.setSpeed.addEventListener('change', () => {
    state.settings.fastSpeed = Number(els.setSpeed.value) || 4;
    saveSettings();
    toast(`加速倍率设为 ${state.settings.fastSpeed}×`);
  });
  els.setVolume.addEventListener('input', () => setVolume(Number(els.setVolume.value) / 100));
  els.setTouch.addEventListener('change', () => {
    state.settings.touch = els.setTouch.value;
    saveSettings();
    applyTouchMode();
  });
  els.setInteger.addEventListener('change', () => {
    state.settings.integerScale = els.setInteger.checked;
    saveSettings();
    fitScreen();
  });
  els.setFps.addEventListener('change', () => {
    state.settings.showFps = els.setFps.checked;
    saveSettings();
    applyFpsVisibility();
  });
  els.setAutosave.addEventListener('change', () => {
    state.settings.autoSaveInterval = Number(els.setAutosave.value) || 0;
    saveSettings();
    applyAutoSave();
    toast(state.settings.autoSaveInterval ? `自动存档间隔 ${state.settings.autoSaveInterval} 秒` : '已关闭自动存档');
  });
  els.setAutorestore.addEventListener('change', () => {
    state.settings.autoRestore = els.setAutorestore.checked;
    saveSettings();
    applyAutoSave();
  });
  els.btnExportSave.addEventListener('click', exportBatterySave);
  els.btnImportSave.addEventListener('click', () => els.saveImportInput.click());
  els.saveImportInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) importBatterySave(file);
    event.target.value = '';
  });
  els.btnReset.addEventListener('click', () => {
    if (!state.playing) return toast('请先载入游戏');
    if (!window.confirm('重置当前游戏？（电池存档会保留）')) return;
    state.emulator.reset();
    state.lastFrameCount = 0;
    state.fpsFrames = 0;
    toast('游戏已重置', 'ok');
  });
  els.btnResetKeys.addEventListener('click', resetKeyBindings);
  els.btnImportState.addEventListener('click', () => els.stateImportInput.click());
  els.stateImportInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await importStateFile(file);
    event.target.value = '';
  });

  els.btnClearAll.addEventListener('click', async () => {
    if (!window.confirm('清空全部游戏、存档和设置？此操作不可撤销。')) return;
    if (state.playing) {
      state.emulator.pause();
      state.input.setEnabled(false);
      state.playing = false;
    }
    stopSaveTicker();
    await state.emulator.clearAllFiles();
    await deleteCoreDatabases();
    await store.clearAll();
    localStorage.removeItem(SETTINGS_KEY);
    location.reload();
  });

  for (const dialog of [els.helpDialog, els.settingsDialog]) {
    dialog.addEventListener('close', () => {
      if (dialog === els.settingsDialog) cancelKeyCapture();
      if (state.playing && !state.paused) state.input?.setEnabled(true);
    });
  }

  document.addEventListener('fullscreenchange', () => {
    fitScreen();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
      closeStatesPanel();
    }
  });

  // Keep the UI in sync with browser-level resume.
  document.addEventListener('pointerdown', () => {
    state.emulator?.resumeAudioContext();
  });
  document.addEventListener('keydown', () => {
    state.emulator?.resumeAudioContext();
  });
}

function setupTouchControls() {
  const buttons = els.touchControls.querySelectorAll('[data-btn]');
  const active = new Map();

  const press = (event) => {
    const button = event.currentTarget.dataset.btn;
    if (!button || !state.playing || state.paused) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    if (active.has(event.pointerId)) return;
    active.set(event.pointerId, button);
    event.currentTarget.classList.add('active');
    state.input.pressFrom(`t:${event.pointerId}`, button);
  };

  const release = (event) => {
    const button = active.get(event.pointerId);
    if (!button) return;
    event.preventDefault();
    active.delete(event.pointerId);
    const element = [...buttons].find((b) => b.dataset.btn === button);
    element?.classList.remove('active');
    state.input.releaseFrom(`t:${event.pointerId}`, button);
  };

  for (const button of buttons) {
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  }
}

function setupDragAndDrop() {
  let dragDepth = 0;
  const showDrop = (show) => els.dropOverlay.classList.toggle('hidden', !show);

  window.addEventListener('dragenter', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    showDrop(true);
  });
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDrop(false);
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    showDrop(false);
    const file = event.dataTransfer.files?.[0];
    if (file) openRomFile(file);
  });
}

function setupAudioUnlock() {
  const unlock = async () => {
    await state.emulator?.resumeAudioContext();
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
    document.removeEventListener('touchstart', unlock);
  };
  document.addEventListener('pointerdown', unlock, { passive: true });
  document.addEventListener('keydown', unlock);
  document.addEventListener('touchstart', unlock, { passive: true });
}

function setupVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.playing && !state.paused) {
        state.autoPaused = true;
        pauseGame();
      }
      captureBatterySave().catch(() => {});
      captureThumbnail().catch(() => {});
    }
  });

  window.addEventListener('pagehide', () => {
    if (state.playing) {
      captureBatterySave().catch(() => {});
      persistPlaytime().catch(() => {});
    }
  });
}

function setupScreenFit() {
  const observer = new ResizeObserver(() => fitScreen());
  observer.observe(els.stage);
  window.addEventListener('resize', fitScreen);
  document.addEventListener('fullscreenchange', fitScreen);
}

function setupPanelsOutsideClick() {
  document.addEventListener('pointerdown', (event) => {
    if (els.statesPanel.classList.contains('hidden')) return;
    if (els.statesPanel.contains(event.target)) return;
    if (els.btnSlots.contains(event.target)) return;
    // Don't close when interacting with a modal dialog.
    if (document.querySelector('dialog[open]')) return;
    closeStatesPanel();
  });
}

function fitScreen() {
  const canvas = els.canvas;
  if (!state.settings.integerScale) {
    canvas.style.width = '';
    canvas.style.height = '';
    canvas.style.objectFit = '';
    return;
  }
  const stage = els.stage;
  const width = Math.max(240, stage.clientWidth - 8);
  const height = Math.max(160, stage.clientHeight - 8);
  const scale = Math.max(1, Math.floor(Math.min(width / 240, height / 160)));
  canvas.style.width = `${240 * scale}px`;
  canvas.style.height = `${160 * scale}px`;
  canvas.style.objectFit = 'fill';
}

/* ------------------------------------------------------------------ loop */

function tick(now) {
  state.input?.pollGamepads();

  if (state.playing && !state.paused) {
    if (state.playStartedAt) {
      state.playAccumMs += now - state.playStartedAt;
      state.playStartedAt = now;
    }

    const frames = state.emulator.frames;
    state.fpsFrames += frames - state.lastFrameCount;
    state.lastFrameCount = frames;
  }

  if (now - state.fpsLast >= 500) {
    const elapsed = now - state.fpsLast;
    state.fps = elapsed > 0 ? Math.round((state.fpsFrames * 1000) / elapsed) : 0;
    state.fpsFrames = 0;
    state.fpsLast = now;
    state.emulator?.refreshAudioState?.();
    updateStats();
  }

  requestAnimationFrame(tick);
}

/* ------------------------------------------------------------- utilities */

/**
 * Emscripten's IDBFS mounts use the mount point as the IndexedDB database name.
 * Delete them too so "clear all data" also removes crash-recovery autosaves
 * even when the core was never booted in this session.
 */
function deleteCoreDatabases() {
  return Promise.all(
    ['/data', '/autosave'].map(
      (name) =>
        new Promise((resolve) => {
          let request;
          try {
            request = indexedDB.deleteDatabase(name);
          } catch {
            resolve();
            return;
          }
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    ),
  );
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function baseNameOf(name) {
  return String(name || 'game.gba').replace(/\.[^.]*$/, '');
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div class="fatal-error">页面初始化失败：${escapeHtml(err.message || err)}<br />请查看控制台日志。</div>`,
  );
});
