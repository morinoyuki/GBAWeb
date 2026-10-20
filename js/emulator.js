/**
 * Thin, app-friendly wrapper around the mGBA WebAssembly core.
 *
 * The core is mGBA v2.5.1 compiled to WASM (@thenick775/mgba-wasm) and runs
 * its own threaded main loop, rendering straight into the supplied canvas.
 */
import mGBA from '../vendor/mgba.js';

const GAMES_DIR = '/data/games';
const SAVES_DIR = '/data/saves';
const STATES_DIR = '/data/states';
const SHOTS_DIR = '/data/screenshots';

export class Emulator {
  constructor(canvas) {
    this.canvas = canvas;
    this.module = null;
    this.bootPromise = null;
    this.rom = null;
    this.frames = 0;
    this.paused = false;
    this.speed = 1;
    this.audioReady = false;
    this.logs = [];

    this.onSaveDataUpdated = null;
    this.onAutoSaveCaptured = null;
    this.onCrash = null;
    this.onLog = null;

    // The C side only attaches callbacks when a core already exists, so this
    // object is (re)registered after every loadGame(). Fresh function
    // references are used each time: Emscripten's addFunction()/removeFunction()
    // bookkeeping gets confused when the same function is re-registered.
    this.coreCallbacks = null;
  }

  makeCoreCallbacks() {
    return {
      videoFrameEndedCallback: () => {
        this.frames++;
      },
      saveDataUpdatedCallback: () => {
        this.onSaveDataUpdated?.();
      },
      autoSaveStateCapturedCallback: () => {
        this.onAutoSaveCaptured?.();
      },
      coreCrashedCallback: () => {
        this.onCrash?.();
      },
    };
  }

  get ready() {
    return Boolean(this.module);
  }

  get loaded() {
    return Boolean(this.module?.gameName && this.rom);
  }

  async boot() {
    if (this.module) return this.module;
    if (this.bootPromise) return this.bootPromise;

    this.bootPromise = (async () => {
      const Module = await mGBA({ canvas: this.canvas });
      await Module.FSInit();

      // We drive input ourselves (keyboard / gamepad / touch) so the built-in
      // SDL key handling (which also hardcodes F/R hotkeys) is disabled.
      Module.toggleInput(false);

      Module.setCoreSettings({
        frameSkip: 0,
        baseFpsTarget: 60,
        audioSampleRate: 48000,
        audioBufferSize: 1024,
        rewindEnable: true,
        rewindBufferCapacity: 1200,
        rewindBufferInterval: 1,
        timestepSync: true,
        videoSync: false,
        audioSync: false,
        allowOpposingDirections: false,
        autoSaveStateEnable: true,
        autoSaveStateTimerIntervalSeconds: 60,
        restoreAutoSaveStateOnLoad: true,
      });
      Module.setVolume(1);

      Module.setLogger((entry) => {
        this.logs.push(entry);
        if (this.logs.length > 500) this.logs.shift();
        this.onLog?.(entry);
      });

      this.module = Module;
      return Module;
    })();

    try {
      return await this.bootPromise;
    } catch (err) {
      this.bootPromise = null;
      throw err;
    }
  }

  get version() {
    return this.module ? `${this.module.version.projectName} ${this.module.version.projectVersion}` : '';
  }

  /**
   * Load a ROM into the core.
   *
   * @param {object} options
   * @param {string} options.name   original file name (extension optional)
   * @param {Uint8Array} options.bytes
   * @param {Uint8Array|null} options.saveBytes  battery save to preload
   * @param {string} options.hash   content hash, used for bookkeeping
   * @param {boolean} options.restoreAutoSaveState  restore crash-recovery state on load
   */
  async loadRom({ name, bytes, saveBytes = null, hash, restoreAutoSaveState = true }) {
    const Module = await this.boot();
    const base = baseName(name);

    // Stop and tear down a previously running game.
    if (this.module?.gameName) {
      try {
        Module.quitGame();
      } catch {
        /* ignore */
      }
    }
    this.rom = null;
    this.paused = false;
    this.frames = 0;
    this.speed = 1;

    for (const dir of [GAMES_DIR, SAVES_DIR, STATES_DIR, SHOTS_DIR]) clearDir(Module, dir);

    const romPath = `${GAMES_DIR}/${base}.gba`;
    Module.FS.writeFile(romPath, bytes);

    if (saveBytes && saveBytes.length) {
      Module.FS.writeFile(`${SAVES_DIR}/${base}.sav`, saveBytes);
    }

    // The auto-restore setting is normally applied by the app. For an
    // imported battery save we temporarily suppress it so the old crash
    // recovery state cannot overwrite the newly imported .sav.
    const appRestore = this.autoSaveSettings
      ? Boolean(this.autoSaveSettings.enabled && this.autoSaveSettings.restoreOnLoad)
      : true;
    let ok = false;
    Module.setCoreSettings({
      restoreAutoSaveStateOnLoad: Boolean(restoreAutoSaveState && appRestore),
    });
    try {
      ok = Module.loadGame(romPath);
    } finally {
      Module.setCoreSettings({ restoreAutoSaveStateOnLoad: appRestore });
    }
    if (!ok) {
      throw new Error('ROM 加载失败（文件可能损坏或不是有效的 GBA ROM）');
    }

    // A fresh core was created, re-attach the JS callbacks to it. Use a new
    // object so pre.js creates fresh wasm function pointers.
    this.coreCallbacks = this.makeCoreCallbacks();
    Module.addCoreCallbacks(this.coreCallbacks);

    this.rom = { name, base, hash, path: romPath };
    this.frames = 0;

    await this.resumeAudioContext();
    Module.resumeGame();
    this.paused = false;
    this.setSpeed(this.speed);
    return this.rom;
  }

  unload() {
    const Module = this.module;
    if (!Module) return;
    if (Module.gameName) {
      try {
        Module.quitGame();
      } catch {
        /* ignore */
      }
    }
    this.rom = null;
    this.paused = false;
    this.frames = 0;
  }

  /* ------------------------------------------------------------ runtime */

  async resumeAudioContext() {
    try {
      const ctx = this.module?.SDL2?.audioContext;
      if (ctx && ctx.state === 'suspended') await ctx.resume();
      this.refreshAudioState();
    } catch {
      this.audioReady = false;
    }
  }

  refreshAudioState() {
    const ctx = this.module?.SDL2?.audioContext;
    if (ctx) this.audioReady = ctx.state === 'running';
    return this.audioReady;
  }

  pause() {
    if (!this.module?.gameName || this.paused) return;
    this.module.pauseGame();
    this.paused = true;
  }

  async resume() {
    if (!this.module?.gameName || !this.paused) return;
    await this.resumeAudioContext();
    this.module.resumeGame();
    this.paused = false;
  }

  reset() {
    const Module = this.module;
    if (!Module?.gameName) return;
    const wasPaused = this.paused;
    // A manual reset should boot the game normally instead of restoring the
    // crash-recovery auto state.
    const restore = Boolean(this.autoSaveSettings?.enabled && this.autoSaveSettings?.restoreOnLoad);
    Module.setCoreSettings({ restoreAutoSaveStateOnLoad: false });
    Module.quickReload();
    Module.setCoreSettings({ restoreAutoSaveStateOnLoad: restore });
    if (wasPaused) Module.pauseGame();
    this.frames = 0;
  }

  setSpeed(multiplier) {
    const value = Math.max(1, Math.round(multiplier) || 1);
    this.speed = value;
    if (this.module?.gameName) {
      this.module.setFastForwardMultiplier(value);
      // setFastForwardMultiplier also changes frameskip; make sure the HUD
      // reflects the requested value.
    }
    return value;
  }

  setVolume(volume01) {
    if (this.module) this.module.setVolume(clamp(volume01, 0, 2));
  }

  setAutoSave({ enabled, intervalSeconds = 60, restoreOnLoad = true }) {
    this.autoSaveSettings = { enabled, intervalSeconds, restoreOnLoad };
    if (!this.module) return;
    this.module.setCoreSettings({
      autoSaveStateEnable: Boolean(enabled),
      autoSaveStateTimerIntervalSeconds: Math.max(10, Math.round(intervalSeconds)),
      restoreAutoSaveStateOnLoad: Boolean(enabled && restoreOnLoad),
    });
  }

  rewind(active) {
    if (!this.module?.gameName) return;
    this.module.toggleRewind(Boolean(active));
  }

  /* ------------------------------------------------------------- input */

  press(button) {
    if (!this.module?.gameName) return;
    this.module.buttonPress(button);
  }

  release(button) {
    if (!this.module?.gameName) return;
    this.module.buttonUnpress(button);
  }

  releaseAll() {
    for (const button of ['A', 'B', 'L', 'R', 'Start', 'Select', 'Up', 'Down', 'Left', 'Right']) {
      this.release(button);
    }
  }

  /* ------------------------------------------------------------ storage */

  getSave() {
    try {
      return this.module?.getSave?.() ?? null;
    } catch {
      return null;
    }
  }

  hasAutoSave() {
    const Module = this.module;
    const path = Module?.autoSaveStateName
      || (this.rom ? `/autosave/${this.rom.base}_auto.ss` : null);
    if (!Module || !path) return false;
    try {
      return Boolean(Module.FS.analyzePath(path).exists);
    } catch {
      return false;
    }
  }

  loadAutoSave() {
    try {
      return Boolean(this.module?.loadAutoSaveState?.());
    } catch {
      return false;
    }
  }

  forceAutoSave() {
    try {
      return Boolean(this.module?.forceAutoSaveState?.());
    } catch {
      return false;
    }
  }

  async clearAutoSave(name = this.rom?.name) {
    const Module = this.module;
    if (!Module || !name) return false;
    const path = `/autosave/${baseName(name)}_auto.ss`;
    let removed = false;
    try {
      Module.FS.unlink(path);
      removed = true;
    } catch {
      /* no auto-save state */
    }
    await this.syncFS();
    return removed;
  }

  /** Remove every on-disk trace of a ROM (autosave, battery save, states). */
  async removeRomFiles(name) {
    const Module = this.module;
    if (!Module) return;
    const base = baseName(name);
    const targets = [`/autosave/${base}_auto.ss`, `${SAVES_DIR}/${base}.sav`];
    for (let slot = 1; slot <= 9; slot++) targets.push(`${STATES_DIR}/${base}.ss${slot}`);
    for (const path of targets) {
      try {
        Module.FS.unlink(path);
      } catch {
        /* not present */
      }
    }
    await this.syncFS();
  }

  /** Wipe all emulator-managed files (used by "clear all data"). */
  async clearAllFiles() {
    const Module = this.module;
    if (!Module) return;
    for (const dir of ['/autosave', GAMES_DIR, SAVES_DIR, STATES_DIR, SHOTS_DIR]) {
      clearDir(Module, dir);
    }
    await this.syncFS();
  }

  async syncFS() {
    try {
      await this.module?.FSSync?.();
    } catch (err) {
      console.warn('FSSync failed', err);
    }
  }

  writeSave(bytes) {
    const Module = this.module;
    if (!Module || !this.rom) return false;
    Module.FS.writeFile(`${SAVES_DIR}/${this.rom.base}.sav`, bytes);
    return true;
  }

  saveState(slot) {
    const Module = this.module;
    if (!Module?.gameName) return null;
    if (!Module.saveState(slot)) return null;
    const path = `${STATES_DIR}/${this.rom.base}.ss${slot}`;
    let bytes;
    try {
      bytes = Module.FS.readFile(path);
    } catch {
      return null;
    }
    return { bytes, thumb: this.screenshot(true), at: Date.now() };
  }

  loadState(slot, bytes) {
    const Module = this.module;
    if (!Module?.gameName) return false;
    Module.FS.writeFile(`${STATES_DIR}/${this.rom.base}.ss${slot}`, bytes);
    return Module.loadState(slot);
  }

  deleteStateFile(slot) {
    const Module = this.module;
    if (!Module || !this.rom) return;
    try {
      Module.FS.unlink(`${STATES_DIR}/${this.rom.base}.ss${slot}`);
    } catch {
      /* ignore */
    }
  }

  /** Capture the current frame as PNG bytes (mGBA's own screenshot code). */
  screenshot(silent = false) {
    const Module = this.module;
    if (!Module?.gameName) return null;
    const fileName = `shot-${Date.now()}.png`;
    let ok = false;
    try {
      ok = Module.screenshot(fileName);
    } catch {
      ok = false;
    }
    if (!ok) {
      if (!silent) console.warn('screenshot failed');
      return null;
    }
    try {
      return Module.FS.readFile(`${SHOTS_DIR}/${fileName}`);
    } catch {
      return null;
    } finally {
      try {
        Module.FS.unlink(`${SHOTS_DIR}/${fileName}`);
      } catch {
        /* ignore */
      }
    }
  }

  status() {
    return {
      version: this.version,
      game: this.rom?.name ?? null,
      paused: this.paused,
      speed: this.speed,
      frames: this.frames,
      audio: this.audioReady,
    };
  }
}

function baseName(name) {
  const clean = String(name || 'game.gba').split(/[\\/]/).pop() || 'game.gba';
  return clean.replace(/\.[^.]*$/, '').replace(/[\u0000-\u001f]/g, '').slice(0, 150) || 'game';
}

function clearDir(Module, dir) {
  let entries = [];
  try {
    entries = Module.FS.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === '.' || entry === '..') continue;
    try {
      Module.FS.unlink(`${dir}/${entry}`);
    } catch {
      /* ignore */
    }
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
