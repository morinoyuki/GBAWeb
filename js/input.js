/**
 * Keyboard, gamepad and touch input.
 *
 * Buttons are tracked per source so that releasing a gamepad button doesn't
 * lift a keyboard key that is still held. Keyboard bindings are user-editable
 * (see the settings dialog) and stored as arrays of KeyboardEvent.code values.
 */

export const BUTTON_LABELS = {
  Up: '十字键 ↑',
  Down: '十字键 ↓',
  Left: '十字键 ←',
  Right: '十字键 →',
  A: 'A 键',
  B: 'B 键',
  L: 'L 键',
  R: 'R 键',
  Start: 'Start',
  Select: 'Select',
};

export const ACTION_LABELS = {
  fastForward: '加速（按住）',
  rewind: '倒带（按住）',
  pause: '暂停 / 继续',
  quickSave: '快速保存',
  quickLoad: '快速读取',
  slotPrev: '上一个存档槽位',
  slotNext: '下一个存档槽位',
  states: '存档槽位面板',
  mute: '静音',
  fullscreen: '全屏',
  help: '帮助',
  settings: '设置',
};

export const DEFAULT_BINDINGS = {
  buttons: {
    Up: ['ArrowUp', 'KeyW'],
    Down: ['ArrowDown', 'KeyS'],
    Left: ['ArrowLeft', 'KeyA'],
    Right: ['ArrowRight', 'KeyD'],
    A: ['KeyZ', 'KeyJ'],
    B: ['KeyX', 'KeyK'],
    L: ['KeyQ', 'KeyU'],
    R: ['KeyE', 'KeyI'],
    Start: ['Enter', 'NumpadEnter'],
    Select: ['ShiftLeft', 'ShiftRight'],
  },
  actions: {
    fastForward: ['Tab'],
    rewind: ['Backspace'],
    pause: ['KeyP'],
    quickSave: ['F2'],
    quickLoad: ['F4'],
    slotPrev: ['BracketLeft'],
    slotNext: ['BracketRight'],
    states: ['KeyG'],
    mute: ['KeyM'],
    fullscreen: ['KeyF'],
    help: ['KeyH'],
    settings: ['KeyO'],
  },
};

export const MAX_KEYS_PER_ACTION = 4;

const HOLD_ACTIONS = new Set(['fastForward', 'rewind']);

// Keys that would make a binding unusable: Escape cancels the capture UI and
// the browser swallows Ctrl/Alt/Meta presses (they set modifier flags).
const RESERVED_CODES = new Set([
  'Escape',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

export function isReservedCode(code) {
  return RESERVED_CODES.has(code);
}

const NAMED_KEYS = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: '空格',
  Enter: 'Enter',
  NumpadEnter: '小键盘 Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  ShiftLeft: '左 Shift',
  ShiftRight: '右 Shift',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  CapsLock: 'CapsLock',
  ContextMenu: '菜单键',
  NumpadAdd: '小键盘 +',
  NumpadSubtract: '小键盘 -',
  NumpadMultiply: '小键盘 *',
  NumpadDivide: '小键盘 /',
  NumpadDecimal: '小键盘 .',
};

export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && /^Numpad\d$/.test(code)) return `小键盘 ${code.slice(6)}`;
  if (NAMED_KEYS[code]) return NAMED_KEYS[code];
  return code;
}

/**
 * Validate and de-duplicate a bindings object. Missing/invalid entries fall
 * back to the defaults; an explicit empty array means "unbound".
 */
export function normalizeBindings(input) {
  const result = { buttons: {}, actions: {} };
  const used = new Set();

  for (const group of ['buttons', 'actions']) {
    const labels = group === 'buttons' ? BUTTON_LABELS : ACTION_LABELS;
    const source = input && typeof input === 'object' ? input[group] : null;
    for (const name of Object.keys(labels)) {
      let codes = source?.[name];
      if (!Array.isArray(codes)) codes = DEFAULT_BINDINGS[group][name];
      const clean = [];
      for (const raw of codes) {
        if (typeof raw !== 'string' || !raw) continue;
        if (RESERVED_CODES.has(raw)) continue;
        if (used.has(raw) || clean.includes(raw)) continue;
        used.add(raw);
        clean.push(raw);
        if (clean.length >= MAX_KEYS_PER_ACTION) break;
      }
      result[group][name] = clean;
    }
  }
  return result;
}

const GAMEPAD_BUTTONS = {
  0: 'A',
  1: 'B',
  2: 'B',
  3: 'B',
  4: 'L',
  5: 'R',
  6: 'L',
  7: 'R',
  8: 'Select',
  9: 'Start',
  12: 'Up',
  13: 'Down',
  14: 'Left',
  15: 'Right',
};

export class InputManager {
  constructor({ bindings = DEFAULT_BINDINGS, onPress, onRelease, onAction, onGamepadConnected } = {}) {
    this.onPress = onPress || (() => {});
    this.onRelease = onRelease || (() => {});
    this.onAction = onAction || (() => {});
    this.onGamepadConnected = onGamepadConnected || (() => {});

    this.enabled = false;
    this.sources = new Map(); // button -> Set<source>
    this.heldActions = new Set();
    this.attached = false;
    this._padSources = new Map();
    this._applyBindings(bindings);

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onGamepad = this._onGamepad.bind(this);
  }

  _applyBindings(bindings) {
    this.bindings = normalizeBindings(bindings);
    this.buttonByCode = new Map();
    this.actionByCode = new Map();
    for (const [name, codes] of Object.entries(this.bindings.buttons)) {
      for (const code of codes) this.buttonByCode.set(code, name);
    }
    for (const [name, codes] of Object.entries(this.bindings.actions)) {
      for (const code of codes) this.actionByCode.set(code, name);
    }
  }

  setBindings(bindings) {
    this._applyBindings(bindings);
    this.releaseEverything();
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseEverything();
    });
    window.addEventListener('gamepadconnected', this._onGamepad);
    window.addEventListener('gamepaddisconnected', this._onGamepad);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.releaseEverything();
  }

  _onGamepad(event) {
    if (event.type === 'gamepadconnected') {
      this.onGamepadConnected?.(event.gamepad);
    }
  }

  _onKeyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTextInput(event.target)) return;
    if (document.querySelector('dialog[open]')) return;

    const code = event.code;
    const button = this.buttonByCode.get(code);
    if (button) {
      // Don't hijack arrows / Enter / Tab for navigation when no game is
      // running (or while the game is paused and input is disabled).
      if (!this.enabled) return;
      event.preventDefault();
      if (event.repeat) return;
      this._pressFrom(`k:${code}`, button);
      return;
    }

    const action = this.actionByCode.get(code);
    if (!action) return;
    // Hold-to-fast-forward / rewind only make sense while a game is running.
    if (!this.enabled && HOLD_ACTIONS.has(action)) return;
    event.preventDefault();

    if (HOLD_ACTIONS.has(action)) {
      if (event.repeat) return;
      if (this.heldActions.has(action)) return;
      this.heldActions.add(action);
      this.onAction(action, 'start');
    } else if (!event.repeat) {
      this.onAction(action, 'tap');
    }
  }

  _onKeyUp(event) {
    const code = event.code;
    const button = this.buttonByCode.get(code);
    if (button) {
      this._releaseFrom(`k:${code}`, button);
      return;
    }
    const action = this.actionByCode.get(code);
    if (action && HOLD_ACTIONS.has(action) && this.heldActions.has(action)) {
      this.heldActions.delete(action);
      this.onAction(action, 'end');
    }
  }

  _onBlur() {
    this.releaseEverything();
  }

  /** Press from a touch pointer or other programmatic source. */
  pressFrom(source, button) {
    this._pressFrom(source, button);
  }

  releaseFrom(source, button) {
    this._releaseFrom(source, button);
  }

  _pressFrom(source, button) {
    if (!this.enabled) return;
    let set = this.sources.get(button);
    if (!set) {
      set = new Set();
      this.sources.set(button, set);
    }
    const wasEmpty = set.size === 0;
    set.add(source);
    if (wasEmpty) this.onPress(button);
  }

  _releaseFrom(source, button) {
    const set = this.sources.get(button);
    if (!set) return;
    set.delete(source);
    if (set.size === 0) {
      this.sources.delete(button);
      this.onRelease(button);
    }
  }

  releaseEverything() {
    for (const [button, set] of [...this.sources]) {
      this.sources.delete(button);
      if (set.size) this.onRelease(button);
    }
    for (const action of [...this.heldActions]) {
      this.heldActions.delete(action);
      this.onAction(action, 'end');
    }
  }

  /** Called every animation frame by the app. */
  pollGamepads() {
    if (!this.enabled || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();

    for (let padIndex = 0; padIndex < pads.length; padIndex++) {
      const pad = pads[padIndex];
      const previous = this._padSources.get(padIndex);

      if (!pad) {
        // Controller unplugged while buttons were held: release them.
        if (previous) {
          for (const source of previous) {
            const name = gamepadSourceButton(source);
            if (name) this._releaseFrom(source, name);
          }
          this._padSources.delete(padIndex);
        }
        continue;
      }

      const active = new Set();
      for (const [index, buttonName] of Object.entries(GAMEPAD_BUTTONS)) {
        if (pad.buttons[Number(index)]?.pressed) {
          active.add(`g:${padIndex}:${index}:${buttonName}`);
        }
      }

      const dead = 0.4;
      const x = pad.axes[0] || 0;
      const y = pad.axes[1] || 0;
      if (x < -dead) active.add(`g:${padIndex}:axisLeft`);
      if (x > dead) active.add(`g:${padIndex}:axisRight`);
      if (y < -dead) active.add(`g:${padIndex}:axisUp`);
      if (y > dead) active.add(`g:${padIndex}:axisDown`);

      if (previous) {
        for (const source of previous) {
          if (!active.has(source)) {
            const name = gamepadSourceButton(source);
            if (name) this._releaseFrom(source, name);
          }
        }
      }
      for (const source of active) {
        const name = gamepadSourceButton(source);
        if (name) this._pressFrom(source, name);
      }
      this._padSources.set(padIndex, active);
    }
  }
}

function gamepadSourceButton(source) {
  const parts = source.split(':');
  if (parts.at(-1) === 'axisLeft') return 'Left';
  if (parts.at(-1) === 'axisRight') return 'Right';
  if (parts.at(-1) === 'axisUp') return 'Up';
  if (parts.at(-1) === 'axisDown') return 'Down';
  return GAMEPAD_BUTTONS[Number(parts[2])];
}

function isTextInput(target) {
  if (!(target instanceof Element)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}
