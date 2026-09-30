/**
 * stem-db.js — IndexedDB wrapper for stem separation data.
 * Stores: models (WASM weights), stems (separated audio), queue (job queue).
 */

const DB_NAME = 'KeyshiftStems';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('models')) {
                db.createObjectStore('models', { keyPath: 'version' });
            }
            if (!db.objectStoreNames.contains('stems')) {
                const store = db.createObjectStore('stems', { keyPath: 'hash' });
                store.createIndex('lastAccessed', 'lastAccessed');
            }
            if (!db.objectStoreNames.contains('queue')) {
                const store = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
                store.createIndex('status', 'status');
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function tx(storeName, mode = 'readonly') {
    return openDB().then(db => {
        const transaction = db.transaction(storeName, mode);
        return transaction.objectStore(storeName);
    });
}

function reqToPromise(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ─── Models ───

async function getModel(version) {
    const store = await tx('models');
    return reqToPromise(store.get(version));
}

async function saveModel(version, weights) {
    const store = await tx('models', 'readwrite');
    return reqToPromise(store.put({ version, weights, downloadedAt: Date.now() }));
}

// ─── Stems ───

async function hashUrl(url) {
    const encoded = new TextEncoder().encode(url);
    const buf = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getStems(url) {
    const hash = await hashUrl(url);
    const store = await tx('stems', 'readwrite');
    const record = await reqToPromise(store.get(hash));
    if (record) {
        record.lastAccessed = Date.now();
        store.put(record);
    }
    return record || null;
}

async function saveStems(url, title, sampleRate, duration, stemBlobs) {
    const hash = await hashUrl(url);
    const store = await tx('stems', 'readwrite');
    return reqToPromise(store.put({
        hash,
        url,
        title,
        sampleRate,
        duration,
        vocals: stemBlobs.vocals,
        drums: stemBlobs.drums,
        bass: stemBlobs.bass,
        other: stemBlobs.other,
        createdAt: Date.now(),
        lastAccessed: Date.now(),
        sizeBytes: Object.values(stemBlobs).reduce((sum, b) => sum + b.size, 0)
    }));
}

async function getTotalStemSize() {
    const store = await tx('stems');
    const all = await reqToPromise(store.getAll());
    return all.reduce((sum, r) => sum + (r.sizeBytes || 0), 0);
}

async function evictLRU(maxBytes) {
    const db = await openDB();
    const transaction = db.transaction('stems', 'readwrite');
    const store = transaction.objectStore('stems');
    const index = store.index('lastAccessed');
    const all = await reqToPromise(index.getAll());

    let total = all.reduce((sum, r) => sum + (r.sizeBytes || 0), 0);
    // Sort oldest-accessed first
    all.sort((a, b) => a.lastAccessed - b.lastAccessed);

    for (const record of all) {
        if (total <= maxBytes) break;
        total -= record.sizeBytes || 0;
        store.delete(record.hash);
    }
}

async function clearAllStems() {
    const store = await tx('stems', 'readwrite');
    return reqToPromise(store.clear());
}

// ─── Queue ───

async function enqueue(url, title, tabId) {
    const store = await tx('queue', 'readwrite');
    return reqToPromise(store.add({
        url,
        title,
        tabId,
        status: 'pending',
        progress: 0,
        error: null,
        addedAt: Date.now()
    }));
}

async function getNextPending() {
    const store = await tx('queue');
    const index = store.index('status');
    const all = await reqToPromise(index.getAll('pending'));
    return all.length > 0 ? all[0] : null;
}

async function updateQueueItem(id, updates) {
    const store = await tx('queue', 'readwrite');
    const item = await reqToPromise(store.get(id));
    if (!item) return;
    Object.assign(item, updates);
    return reqToPromise(store.put(item));
}

async function getQueueItems() {
    const store = await tx('queue');
    return reqToPromise(store.getAll());
}

async function removeQueueItem(id) {
    const store = await tx('queue', 'readwrite');
    return reqToPromise(store.delete(id));
}

async function clearQueue() {
    const store = await tx('queue', 'readwrite');
    return reqToPromise(store.clear());
}

// Export for use in offscreen.js / other modules
if (typeof globalThis !== 'undefined') {
    globalThis.StemDB = {
        getModel, saveModel,
        getStems, saveStems, hashUrl, getTotalStemSize, evictLRU, clearAllStems,
        enqueue, getNextPending, updateQueueItem, getQueueItems, removeQueueItem, clearQueue
    };
}
