'use strict';

const log = (...args) => console.log('[KS:bg]', ...args);
const warn = (...args) => console.warn('[KS:bg]', ...args);

const PITCH_MIN = -12;
const PITCH_MAX = 12;
const TUNE_MIN = -1;
const TUNE_MAX = 1;
const TEMPO_MIN = 0.25;
const TEMPO_MAX = 2.5;
const TEMPO_MAX_NO_MEDIA = 1;
const CONTENT_TIMEOUT_MS = 3500;
const STOP_WAIT_MS = 250;
const SESSION_KEY = 'ksSession';
const CAPTURE_TIMEOUT_MS = 8000;
const STEM_STALE_MS = 15 * 60 * 1000;

const BLOCKED_URL_PREFIXES = [
    'chrome://', 'chrome-extension://', 'edge://', 'about:', 'file://', 'view-source:', 'devtools://',
    'https://chrome.google.com/webstore', 'https://chromewebstore.google.com'
];

// ─── State ───

let tab = null;          // captured tab state, or null
let popupPort = null;
let starting = false;
let startedAt = 0;

function newTabState(tabId, url) {
    return {
        tabId,
        url: url || '',
        connected: false,
        tempo: 1,
        pitch: 0,
        tune: 0,
        hasMedia: false,
        paused: true,
        currentTime: 0,
        duration: 0,
        loopA: null,
        loopB: null,
        src: null,
        title: '',
        stem: newStemState()
    };
}

function newStemState() {
    return {phase: 'idle', progress: 0, stage: '', url: null, active: false, states: {}, message: '', updatedAt: Date.now()};
}

// The worker can be stopped at any time, so keep the captured tab in session storage.
const loaded = chrome.storage.session.get(SESSION_KEY).then(async (data) => {
    const saved = data && data[SESSION_KEY];
    if (saved && saved.tabId != null && await offscreenExists()) {
        tab = saved;
        log('restored session for tab', tab.tabId);
    }
}).catch((err) => warn('session restore failed:', err.message));

let persistTimer = null;
function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        chrome.storage.session.set({[SESSION_KEY]: tab}).catch(() => {});
    }, 200);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round2 = (v) => Math.round(v * 100) / 100;

function maxTempo() {
    return tab && tab.hasMedia ? TEMPO_MAX : TEMPO_MAX_NO_MEDIA;
}

// ─── Popup messaging ───

function postPopup(msg) {
    if (!popupPort) return;
    try {
        popupPort.postMessage(msg);
    } catch (err) {
        popupPort = null;
    }
}

function publicState(extra) {
    return Object.assign({kind: 'state', state: tab ? Object.assign({}, tab) : null}, extra || {});
}

function sendState(extra) {
    postPopup(publicState(extra));
}

// ─── Offscreen document ───

async function offscreenExists() {
    try {
        const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
        return contexts.length > 0;
    } catch (err) {
        return false;
    }
}

async function ensureOffscreen() {
    if (await offscreenExists()) return;
    try {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['USER_MEDIA'],
            justification: 'Process tab audio to change pitch and tempo.'
        });
    } catch (err) {
        if (!/single offscreen|already exists/i.test(err.message)) throw err;
    }
}

function toOffscreen(type, data) {
    const msg = Object.assign({target: 'offscreen', type}, data || {});
    return chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Content script ───

async function injectContent(tabId) {
    try {
        await chrome.scripting.executeScript({target: {tabId}, files: ['content.js']});
        return true;
    } catch (err) {
        warn('inject failed:', err.message);
        return false;
    }
}

function toContent(tabId, action, data, timeoutMs) {
    const msg = Object.assign({ks: 'cmd', action}, data || {});
    const send = chrome.tabs.sendMessage(tabId, msg).catch(() => null);
    if (!timeoutMs) return send;
    return Promise.race([send, sleep(timeoutMs).then(() => null)]);
}

function applyMediaState(m) {
    if (!tab || !m) return;
    const hadMedia = tab.hasMedia;
    const oldSrc = tab.src;
    tab.hasMedia = !!m.hasMedia;
    if (m.hasMedia) {
        tab.paused = !!m.paused;
        tab.currentTime = m.currentTime || 0;
        tab.duration = isFinite(m.duration) ? m.duration : 0;
        tab.loopA = m.loopA;
        tab.loopB = m.loopB;
        tab.src = m.src || null;
    } else {
        tab.paused = true;
        tab.currentTime = 0;
        tab.duration = 0;
        tab.src = null;
        tab.loopA = null;
        tab.loopB = null;
    }
    tab.title = m.title || tab.title;
    if (tab.src !== oldSrc && !tab.stem.active && (tab.stem.phase === 'ready' || tab.stem.phase === 'error')) {
        tab.stem = newStemState();
    }
    if (hadMedia !== tab.hasMedia && tab.connected) {
        toOffscreen('set-has-media', {hasMedia: tab.hasMedia});
        applyTempo();
    }
    persist();
}

async function refreshMedia() {
    if (!tab) return;
    const m = await toContent(tab.tabId, 'get-state', null, CONTENT_TIMEOUT_MS);
    if (m) applyMediaState(m);
}

// Without a content script the page can't be controlled, so tempo goes through offscreen.
async function reattachContent() {
    if (!tab) return;
    if (await injectContent(tab.tabId)) {
        toContent(tab.tabId, 'report', {on: true});
        await refreshMedia();
    } else {
        applyMediaState({hasMedia: false});
    }
}

// ─── Capture ───

function isBlockedUrl(url) {
    if (!url) return true;
    return BLOCKED_URL_PREFIXES.some((p) => url.startsWith(p));
}

async function stopOffscreenCapture() {
    if (await offscreenExists()) {
        await toOffscreen('stop-capture');
        await sleep(STOP_WAIT_MS);
    }
}

async function startCapture(target) {
    starting = true;
    startedAt = Date.now();
    try {
        await stopOffscreenCapture();
        tab = newTabState(target.id, target.url);
        persist();
        sendState();

        if (await injectContent(target.id)) {
            // Enable reports first so state keeps flowing even if get-state is slow.
            toContent(target.id, 'report', {on: true});
            await refreshMedia();
        }
        if (!tab || tab.tabId !== target.id) return;

        await ensureOffscreen();
        const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId: target.id});
        await toOffscreen('start-capture', {streamId, settings: {media: tab.hasMedia}});
        sendState({fresh: true});
        const startTime = startedAt;
        setTimeout(() => {
            if (starting && startedAt === startTime) {
                warn('capture timed out');
                onCaptureFailure();
            }
        }, CAPTURE_TIMEOUT_MS);
    } catch (err) {
        warn('capture failed:', err.message);
        starting = false;
        tab = null;
        persist();
        postPopup({kind: 'error', message: 'Could not capture audio in this tab.'});
        sendState();
    }
}

function onCaptureReady() {
    starting = false;
    if (!tab) return;
    tab.connected = true;
    toOffscreen('set-has-media', {hasMedia: tab.hasMedia});
    toOffscreen('set-pitch', {pitchShift: tab.pitch + tab.tune});
    applyTempo();
    persist();
    sendState();
}

function onCaptureFailure() {
    starting = false;
    tab = null;
    persist();
    postPopup({kind: 'error', message: 'Could not capture audio in this tab.'});
    sendState();
}

async function forgetTab(resetPage) {
    if (!tab) return;
    const tabId = tab.tabId;
    tab = null;
    persist();
    if (resetPage) {
        await toContent(tabId, 'set-rate', {rate: 1});
        await toContent(tabId, 'loop-clear');
        toContent(tabId, 'report', {on: false});
    }
    await toOffscreen('stop-capture');
    sendState();
}

function clearStaleStem() {
    const stem = tab && tab.stem;
    if (stem && stem.phase === 'working' && Date.now() - (stem.updatedAt || 0) > STEM_STALE_MS) {
        tab.stem = newStemState();
        persist();
    }
}

async function onPopupConnect() {
    await loaded;
    // A capture is already starting: just show it, don't start a second one.
    if (starting && tab) {
        sendState();
        return;
    }

    const [active] = await chrome.tabs.query({active: true, currentWindow: true});
    const activeOk = !!active && !isBlockedUrl(active.url);

    if (tab && tab.connected) {
        const exists = await chrome.tabs.get(tab.tabId).catch(() => null);
        const sameTab = !activeOk || active.id === tab.tabId;
        if (exists && sameTab && await offscreenExists()) {
            tab.url = exists.url || tab.url;
            clearStaleStem();
            await reattachContent();
            sendState();
            return;
        }
        // The popup opened on another page, so release the old tab.
        await forgetTab(!!exists);
    } else if (tab) {
        tab = null;
        persist();
    }

    if (!activeOk) {
        postPopup({kind: 'unsupported'});
        return;
    }
    await startCapture(active);
}

// ─── Settings ───

function applyTempo() {
    if (!tab) return;
    tab.tempo = clamp(tab.tempo, TEMPO_MIN, maxTempo());
    if (tab.hasMedia) {
        toContent(tab.tabId, 'set-rate', {rate: tab.tempo});
        if (tab.connected) toOffscreen('set-rate', {rate: 1});
    } else if (tab.connected) {
        toOffscreen('set-rate', {rate: tab.tempo});
    }
}

function setPitch(pitch, tune) {
    if (!tab) return;
    if (pitch != null) tab.pitch = clamp(Math.round(pitch), PITCH_MIN, PITCH_MAX);
    if (tune != null) tab.tune = round2(clamp(tune, TUNE_MIN, TUNE_MAX));
    toOffscreen('set-pitch', {pitchShift: tab.pitch + tab.tune});
    persist();
}

function setTempo(tempo) {
    if (!tab) return;
    tab.tempo = round2(tempo);
    applyTempo();
    persist();
}

// ─── Popup commands ───

async function onPopupCommand(msg) {
    await loaded;
    if (!tab) return;
    const tabId = tab.tabId;

    switch (msg.cmd) {
        case 'set-pitch':
            setPitch(msg.value, null);
            break;
        case 'set-tune':
            setPitch(null, msg.value);
            break;
        case 'set-tempo':
            setTempo(msg.value);
            break;
        case 'set-all':
            setPitch(msg.pitch, msg.tune);
            setTempo(msg.tempo);
            break;
        case 'resync':
            toOffscreen('sync-audio');
            break;
        case 'toggle-play':
        case 'seek-start':
            await toContent(tabId, msg.cmd);
            break;
        case 'seek-by':
            await toContent(tabId, 'seek-by', {delta: msg.delta});
            break;
        case 'seek-to':
            await toContent(tabId, 'seek-to', {time: msg.time});
            break;
        case 'loop-a':
        case 'loop-b':
        case 'loop-clear': {
            const reply = await toContent(tabId, msg.cmd);
            if (reply && reply.state) applyMediaState(reply.state);
            postPopup({kind: 'loop-result', cmd: msg.cmd, ok: !!(reply && reply.ok), reason: reply ? reply.reason : 'no-media'});
            break;
        }
        case 'disconnect':
            await forgetTab(true);
            return;
        case 'stem-separate':
            if (!tab.src) return;
            tab.stem = Object.assign(newStemState(), {phase: 'working', stage: 'queued'});
            toOffscreen('stem-separate', {url: tab.src, title: tab.title, tabId});
            break;
        case 'stem-record-start':
            tab.stem = Object.assign(newStemState(), {phase: 'recording'});
            toOffscreen('stem-record-start');
            break;
        case 'stem-record-stop':
            tab.stem.phase = 'working';
            tab.stem.stage = 'processing';
            tab.stem.progress = 0;
            tab.stem.updatedAt = Date.now();
            toOffscreen('stem-record-stop', {title: tab.title, tabId});
            break;
        case 'stem-toggle':
            toOffscreen('stem-toggle', {stem: msg.stem});
            return;
        case 'stem-activate':
            if (!tab.stem.url) return;
            tab.stem.active = true;
            toOffscreen('stem-activate', {url: tab.stem.url});
            break;
        case 'stem-deactivate':
            tab.stem.active = false;
            tab.stem.states = {};
            toOffscreen('stem-deactivate');
            break;
        default:
            warn('unknown popup command', msg.cmd);
            return;
    }
    persist();
    sendState();
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ks-popup') return;
    popupPort = port;
    port.onMessage.addListener((msg) => {
        onPopupCommand(msg).catch((err) => warn('command failed:', err.message));
    });
    port.onDisconnect.addListener(() => {
        if (popupPort === port) popupPort = null;
    });
    onPopupConnect().catch((err) => {
        warn('popup init failed:', err.message);
        postPopup({kind: 'error', message: 'Could not start Keyshift in this tab.'});
    });
});

// ─── Offscreen and content messages ───

function onStemMessage(msg) {
    if (!tab) return;
    if (msg.tabId != null && msg.tabId !== tab.tabId) return;
    const stem = tab.stem;
    stem.updatedAt = Date.now();

    switch (msg.type) {
        case 'stem-progress':
            stem.phase = 'working';
            stem.progress = msg.progress || 0;
            stem.stage = msg.stage || stem.stage;
            break;
        case 'stem-ready':
            stem.phase = 'ready';
            stem.progress = 1;
            stem.stage = 'complete';
            stem.url = msg.url;
            stem.active = true;
            toOffscreen('stem-activate', {url: msg.url});
            break;
        case 'stem-error':
            stem.phase = 'error';
            stem.message = msg.message || '';
            break;
        case 'stem-recording-started':
            stem.phase = 'recording';
            break;
        case 'stem-recording-stopped':
            stem.phase = 'working';
            stem.stage = 'processing';
            break;
        case 'stem-states':
            stem.states = msg.states || {};
            break;
    }
    persist();
    postPopup({kind: 'stem', msg, stem: Object.assign({}, stem)});
}

function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

async function fetchAudio(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Fetch failed with status ' + response.status);
    return toBase64(await response.arrayBuffer());
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    // Messages from the content script.
    if (msg.ks && sender.tab) {
        loaded.then(() => {
            if (!tab || sender.tab.id !== tab.tabId || sender.frameId !== 0) return;
            if (msg.ks === 'media-state') {
                applyMediaState(msg.state);
                sendState();
            } else if (msg.ks === 'loop-jump') {
                postPopup({kind: 'loop-jump'});
            }
        });
        return;
    }

    // offscreen.js sends these two without a target.
    if (msg.type === 'offscreen-ready') {
        loaded.then(onCaptureReady);
        return;
    }
    if (msg.type === 'offscreen-capture-failure') {
        loaded.then(onCaptureFailure);
        return;
    }

    if (msg.target !== 'background') return;

    if (msg.type === 'fetch-audio') {
        fetchAudio(msg.url)
            .then((data) => sendResponse({data}))
            .catch((err) => sendResponse({error: err.message}));
        return true;
    }

    if (msg.type && msg.type.startsWith('stem-')) {
        loaded.then(() => onStemMessage(msg));
    }
});

// ─── Tab lifecycle ───

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await loaded;
    if (tab && tab.tabId === tabId) {
        log('captured tab closed');
        await forgetTab(false);
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, updated) => {
    await loaded;
    if (!tab || tab.tabId !== tabId || info.status !== 'complete') return;
    // A navigation removes the content script, so put it back.
    tab.url = updated.url || tab.url;
    if (isBlockedUrl(tab.url)) {
        applyMediaState({hasMedia: false});
    } else {
        await reattachContent();
    }
    applyTempo();
    sendState();
});

chrome.tabCapture.onStatusChanged.addListener(async (info) => {
    await loaded;
    if (!tab || info.tabId !== tab.tabId) return;
    if (info.status !== 'stopped' && info.status !== 'error') return;
    // Ignore the stop event from our own restart of the capture.
    if (starting || Date.now() - startedAt < 1500) return;
    log('capture status', info.status);
    await forgetTab(false);
});

// ─── Keyboard commands ───

chrome.commands.onCommand.addListener(async (command) => {
    await loaded;
    if (!tab) {
        log('command ignored, no captured tab:', command);
        return;
    }
    switch (command) {
        case 'pitch-up':
            setPitch(tab.pitch + 1, null);
            break;
        case 'pitch-down':
            setPitch(tab.pitch - 1, null);
            break;
        case 'speed-up':
            setTempo(tab.tempo + 0.05);
            break;
        case 'speed-down':
            setTempo(tab.tempo - 0.05);
            break;
        default:
            return;
    }
    sendState();
});
