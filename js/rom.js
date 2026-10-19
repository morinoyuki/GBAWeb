/**
 * ROM file handling: .gba files, .zip archives, header sanity checks and
 * content hashing (used as a stable key for saves and save states).
 */
import { unzipSync } from '../vendor/fflate.js';

const ROM_EXTENSIONS = ['.gba', '.agb', '.bin'];

export { ROM_EXTENSIONS };

/**
 * Read a user supplied ROM file.
 * @param {File} file
 * @returns {Promise<{name: string, bytes: Uint8Array, hash: string, size: number, warnings: string[]}>}
 */
export async function readRomFile(file) {
  if (!file) throw new Error('未选择文件');
  const raw = new Uint8Array(await file.arrayBuffer());
  const lower = file.name.toLowerCase();

  let name = file.name;
  let bytes = raw;
  const warnings = [];

  if (lower.endsWith('.zip')) {
    let entries;
    try {
      entries = unzipSync(raw);
    } catch (err) {
      throw new Error('无法解压 ZIP：' + (err?.message || err));
    }
    const totalBytes = Object.values(entries).reduce((sum, data) => sum + data.length, 0);
    if (totalBytes > 128 * 1024 * 1024) {
      throw new Error('ZIP 解压后超过 128 MB，已拒绝载入');
    }
    const candidates = Object.entries(entries)
      .filter(([entryName, data]) => ROM_EXTENSIONS.some((ext) => entryName.toLowerCase().endsWith(ext)) && data.length > 0)
      .sort((a, b) => b[1].length - a[1].length);
    if (!candidates.length) {
      throw new Error('ZIP 中没有找到 .gba 文件');
    }
    if (candidates.length > 1) {
      warnings.push(`ZIP 中有 ${candidates.length} 个 ROM，已选择最大的那个`);
    }
    const [entryName, data] = candidates[0];
    name = entryName.split('/').pop() || entryName;
    bytes = data;
  } else if (!ROM_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    throw new Error('不支持的文件类型，请选择 .gba 或 .zip');
  }

  if (bytes.length < 0xc0) {
    throw new Error('文件太小，不像是 GBA ROM');
  }

  checkHeader(bytes, warnings);

  const hash = await sha256Hex(bytes);
  return { name: cleanFileName(name), bytes, hash, size: bytes.length, warnings };
}

function checkHeader(bytes, warnings) {
  // 0xB2 is the fixed value 0x96 in every GBA cartridge header. Homebrew and
  // patched ROMs may omit it, so this is only a warning.
  if (bytes[0xb2] !== 0x96) {
    warnings.push('ROM 头部校验字节异常，可能不是标准 GBA ROM');
  }
}

export function cleanFileName(name) {
  return name.replace(/[\\/]+/g, '_').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) || 'game.gba';
}

export function baseNameFor(name) {
  const cleaned = cleanFileName(name);
  return cleaned.replace(/\.[^.]*$/, '') || 'game';
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export async function sha256Hex(bytes) {
  if (globalThis.crypto?.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* fall through to the JS hash */
    }
  }
  return fnv1a128Hex(bytes);
}

/**
 * Deterministic 128-bit FNV-1a hash used as a fallback when SubtleCrypto is
 * unavailable (non-secure contexts). Not cryptographic, plenty for file keys.
 */
function fnv1a128Hex(bytes) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h2 = Math.imul(h2 + v + i, 0x85ebca6b) ^ (h2 >>> 13);
    h3 = Math.imul(h3 ^ (v + (h3 >>> 7)), 0xc2b2ae35);
    h4 = (h4 + Math.imul(v, 0x27d4eb2d)) ^ (h4 >>> 15);
  }
  const part = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return part(h1) + part(h2) + part(h3) + part(h4);
}
