/**
 * Persistent storage for GBA Web.
 *
 * Everything lives in IndexedDB so ROMs, battery saves and save states
 * survive page reloads. Large payloads (ROM bytes, states, PNG thumbnails)
 * are stored as ArrayBuffer.
 */

const DB_NAME = 'gba-web';
const DB_VERSION = 2;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('当前浏览器不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains('roms')) {
        db.createObjectStore('roms', { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains('romData')) {
        db.createObjectStore('romData', { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains('saves')) {
        db.createObjectStore('saves', { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains('states')) {
        db.createObjectStore('states', { keyPath: ['hash', 'slot'] });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      // v1 stored ROM bytes inside the metadata records. Move them out so the
      // library list never has to deserialize tens of megabytes per game.
      if (event.oldVersion < 2) {
        const romStore = tx.objectStore('roms');
        const dataStore = tx.objectStore('romData');
        romStore.openCursor().onsuccess = (cursorEvent) => {
          const cursor = cursorEvent.target.result;
          if (!cursor) return;
          const record = cursor.value;
          if (record.bytes) {
            dataStore.put({ hash: record.hash, bytes: record.bytes });
            delete record.bytes;
            cursor.update(record);
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('打开 IndexedDB 失败'));
  });
  return dbPromise;
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  });
}

async function withStore(name, mode, fn) {
  const db = await openDB();
  const tx = db.transaction(name, mode);
  const store = tx.objectStore(name);
  const result = fn(store);
  await txDone(tx);
  return result;
}

/* ------------------------------------------------------------------ ROMs */

export async function listRoms() {
  const db = await openDB();
  const tx = db.transaction('roms', 'readonly');
  const all = await reqToPromise(tx.objectStore('roms').getAll());
  return all.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
}

export async function getRom(hash) {
  const db = await openDB();
  const tx = db.transaction(['roms', 'romData'], 'readonly');
  const metaReq = tx.objectStore('roms').get(hash);
  const dataReq = tx.objectStore('romData').get(hash);
  const [meta, data] = await Promise.all([reqToPromise(metaReq), reqToPromise(dataReq)]);
  if (!meta) return null;
  return { ...meta, bytes: data?.bytes ?? null };
}

/** Metadata only — cheap even for a library full of large ROMs. */
export async function getRomMeta(hash) {
  const db = await openDB();
  const tx = db.transaction('roms', 'readonly');
  return reqToPromise(tx.objectStore('roms').get(hash));
}

/**
 * Store a ROM. `bytes` is split into the romData store so listRoms() stays
 * cheap; the metadata record keeps name/size/thumb/playtime.
 */
export async function putRom(rom) {
  const db = await openDB();
  const tx = db.transaction(['roms', 'romData'], 'readwrite');
  const { bytes, ...meta } = rom;
  tx.objectStore('roms').put(meta);
  if (bytes) {
    tx.objectStore('romData').put({ hash: rom.hash, bytes: toArrayBuffer(bytes) });
  }
  await txDone(tx);
}

export async function updateRom(hash, patch) {
  const db = await openDB();
  const tx = db.transaction('roms', 'readwrite');
  const store = tx.objectStore('roms');
  const existing = await reqToPromise(store.get(hash));
  if (!existing) {
    await txDone(tx);
    return null;
  }
  const next = { ...existing, ...patch, hash };
  store.put(next);
  await txDone(tx);
  return next;
}

export async function deleteRom(hash) {
  const db = await openDB();
  const tx = db.transaction(['roms', 'romData', 'saves', 'states'], 'readwrite');
  tx.objectStore('roms').delete(hash);
  tx.objectStore('romData').delete(hash);
  tx.objectStore('saves').delete(hash);
  const states = tx.objectStore('states');
  const keys = await reqToPromise(states.getAllKeys());
  for (const key of keys) {
    if (Array.isArray(key) && key[0] === hash) states.delete(key);
  }
  await txDone(tx);
}

/* ------------------------------------------------------- battery saves */

export async function getSave(hash) {
  const db = await openDB();
  const tx = db.transaction('saves', 'readonly');
  return reqToPromise(tx.objectStore('saves').get(hash));
}

export async function putSave(hash, bytes) {
  const buffer = toArrayBuffer(bytes);
  return withStore('saves', 'readwrite', (store) =>
    store.put({ hash, bytes: buffer, updatedAt: Date.now() }),
  );
}

export async function deleteSave(hash) {
  return withStore('saves', 'readwrite', (store) => store.delete(hash));
}

/* ---------------------------------------------------------- save states */

export async function listStates(hash) {
  const db = await openDB();
  const tx = db.transaction('states', 'readonly');
  const all = await reqToPromise(tx.objectStore('states').getAll());
  return all.filter((s) => s.hash === hash).sort((a, b) => a.slot - b.slot);
}

export async function getState(hash, slot) {
  const db = await openDB();
  const tx = db.transaction('states', 'readonly');
  return reqToPromise(tx.objectStore('states').get([hash, slot]));
}

export async function putState(state) {
  const record = {
    ...state,
    bytes: toArrayBuffer(state.bytes),
    thumb: state.thumb ? toArrayBuffer(state.thumb) : null,
  };
  return withStore('states', 'readwrite', (store) => store.put(record));
}

export async function deleteState(hash, slot) {
  return withStore('states', 'readwrite', (store) => store.delete([hash, slot]));
}

/* -------------------------------------------------------------- metadata */

export async function getMeta(key, fallback = null) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readonly');
  const rec = await reqToPromise(tx.objectStore('meta').get(key));
  return rec ? rec.value : fallback;
}

export async function setMeta(key, value) {
  return withStore('meta', 'readwrite', (store) => store.put({ key, value }));
}

/* ------------------------------------------------------------- utilities */

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['roms', 'romData', 'saves', 'states', 'meta'], 'readwrite');
  tx.objectStore('roms').clear();
  tx.objectStore('romData').clear();
  tx.objectStore('saves').clear();
  tx.objectStore('states').clear();
  tx.objectStore('meta').clear();
  await txDone(tx);
}

/** Approximate number of bytes used by stored blobs. */
export async function estimateUsage() {
  try {
    const est = await navigator.storage?.estimate?.();
    return est?.usage ?? null;
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  throw new TypeError('期望二进制数据');
}
