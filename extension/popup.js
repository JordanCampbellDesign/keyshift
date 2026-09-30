'use strict';

const log = (...args) => console.log('[KS:popup]', ...args);

const PAGES_KEY = 'pageSettings';
const MAX_PAGES = 100;
const SAVE_DELAY_MS = 500;
const TOAST_MS = 3000;
const SEEK_STEP = 5;
const TEMPO_MIN = 25;
const TEMPO_MAX = 250;
const TEMPO_MAX_NO_MEDIA = 100;
const TEMPO_KEY_STEP = 5;

// Tempo slider: 0..500 covers 25%..100%, 500..1000 covers 100%..250%.
// This puts 100% in the middle and gives each half the full width.
const SLIDER_MID = 500;
const SLIDER_MAX = 1000;

const STAGE_LABELS = {
    queued: 'Starting',
    processing: 'Processing recorded audio',
    decoding: 'Decoding audio',
    encoding: 'Encoding stems',
    complete: 'Complete'
};

const $ = (id) => document.getElementById(id);

const el = {
    statusDot: $('statusDot'),
    status: $('connectionDisplay'),
    disconnect: $('disconnectButton'),
    theme: $('themeButton'),
    sun: $('themeIconSun'),
    moon: $('themeIconMoon'),
    pitchDisplay: $('pitchShiftDisplay'),
    pitchSlider: $('pitchSlider'),
    pitchReset: $('pitchReset'),
    tuneDisplay: $('tuneShiftDisplay'),
    tuneSlider: $('tuneSlider'),
    tuneReset: $('tuneReset'),
    tempoDisplay: $('tempoDisplay'),
    tempoSlider: $('tempoSlider'),
    tempoReset: $('tempoReset'),
    stemsStatus: $('stemsStatus'),
    stemsButton: $('stemsSeparate'),
    stemsProgress: $('stemsProgress'),
    stemsFill: $('stemsProgressFill'),
    stemsText: $('stemsProgressText'),
    stemToggles: $('stemToggles'),
    loopA: $('loopButtonA'),
    loopB: $('loopButtonB'),
    loopReset: $('loopReset'),
    rampToggle: $('rampToggle'),
    rampStep: $('rampStep'),
    rampTarget: $('rampTarget'),
    transport: $('playContainer'),
    skipStart: $('skipBeginning'),
    seekBack: $('seekReverse'),
    play: $('playPause'),
    playIcon: $('playIcon'),
    pauseIcon: $('pauseIcon'),
    resyncIcon: $('resyncIcon'),
    seekFwd: $('seekForward'),
    timeline: $('timeline'),
    timelineBar: $('timelineBar'),
    timelineLoop: $('timelineLoop'),
    timelineProgress: $('timelineProgress'),
    markerA: $('markerA'),
    markerB: $('markerB'),
    playhead: $('timelinePlayhead'),
    timeDisplay: $('timeDisplay'),
    position: $('positionDisplay'),
    duration: $('durationDisplay'),
    snackbar: $('snackbar')
};

const groups = {};
document.querySelectorAll('.control-group[data-control]').forEach((g) => {
    groups[g.dataset.control] = g;
});

let port = null;
let state = null;
let unsupported = false;
let restoreStarted = false;
let restoreChecked = false;
let lastSaved = null;

// ─── Helpers ───

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function send(cmd, data) {
    if (!port) return;
    port.postMessage(Object.assign({cmd}, data || {}));
}

function signed(value, decimals) {
    const text = Math.abs(value).toFixed(decimals);
    if (Number(text) === 0) return decimals ? (0).toFixed(decimals) : '0';
    return (value > 0 ? '+' : '-') + text;
}

function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    const s = Math.floor(sec);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function tempoToSlider(pct) {
    if (pct <= 100) return Math.round(((pct - TEMPO_MIN) / (100 - TEMPO_MIN)) * SLIDER_MID);
    return Math.round(SLIDER_MID + ((pct - 100) / (TEMPO_MAX - 100)) * (SLIDER_MAX - SLIDER_MID));
}

function sliderToTempo(v) {
    let pct;
    if (v <= SLIDER_MID) {
        pct = TEMPO_MIN + (v / SLIDER_MID) * (100 - TEMPO_MIN);
    } else {
        pct = 100 + ((v - SLIDER_MID) / (SLIDER_MAX - SLIDER_MID)) * (TEMPO_MAX - 100);
    }
    pct = Math.round(pct);
    return Math.abs(pct - 100) <= 2 ? 100 : pct;
}

function hasMedia() {
    return !!(state && state.connected && state.hasMedia);
}

function tempoMax() {
    return state && state.hasMedia ? TEMPO_MAX : TEMPO_MAX_NO_MEDIA;
}

let toastTimer = null;
function toast(text) {
    el.snackbar.textContent = text;
    el.snackbar.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.snackbar.classList.remove('show'), TOAST_MS);
}

function setDisabled(group, disabled) {
    if (!group) return;
    group.classList.toggle('disabledState', disabled);
    group.querySelectorAll('button, input').forEach((c) => {
        c.disabled = disabled;
    });
}

// ─── Actions ───

function setPitch(value) {
    const v = clamp(Math.round(value), -12, 12);
    if (state) state.pitch = v;
    send('set-pitch', {value: v});
    render();
}

function setTune(value) {
    const v = Math.round(clamp(value, -1, 1) * 100) / 100;
    if (state) state.tune = v;
    send('set-tune', {value: v});
    render();
}

function setTempoPct(pct) {
    const v = clamp(Math.round(pct), TEMPO_MIN, tempoMax());
    if (state) state.tempo = v / 100;
    send('set-tempo', {value: v / 100});
    render();
}

function tempoPct() {
    return state ? Math.round(state.tempo * 100) : 100;
}

function resetAll() {
    setPitch(0);
    setTune(0);
    if (hasMedia() || tempoPct() !== 100) setTempoPct(100);
}

// ─── Rendering ───

function renderStatus() {
    const connected = !!(state && state.connected);
    el.statusDot.classList.toggle('connected', connected);
    if (unsupported) {
        el.status.textContent = 'Keyshift cannot run on this page. Open a tab that plays audio.';
    } else if (!state) {
        el.status.textContent = 'Disconnected';
    } else if (!connected) {
        el.status.textContent = 'Connecting...';
    } else if (!state.hasMedia && state.tempo < 1) {
        el.status.textContent = 'Connected. Audio is behind live. Press Resync.';
    } else {
        el.status.textContent = 'Connected';
    }
}

function renderControls() {
    const connected = !!(state && state.connected);
    const media = hasMedia();

    setDisabled(groups.pitch, !connected);
    setDisabled(groups.tune, !connected);
    setDisabled(groups.tempo, !media);
    setDisabled(groups.loop, !media);
    setDisabled(groups.ramp, !media);
    setDisabled(el.transport, !media);
    el.timeline.classList.toggle('disabledState', !media);
    el.timeDisplay.classList.toggle('disabledState', !media);

    document.querySelectorAll('.no-media-hint').forEach((h) => {
        h.classList.toggle('hidden', !connected || media);
    });

    // Without a media element the play button becomes Resync.
    el.play.disabled = !connected;
    el.transport.classList.toggle('disabledState', !connected);
    el.resyncIcon.classList.toggle('hidden', !connected || media);
    const paused = !state || state.paused;
    el.playIcon.classList.toggle('hidden', connected && (!media || !paused));
    el.pauseIcon.classList.toggle('hidden', !media || paused);
    el.play.title = connected && !media ? 'Resync audio to live' : 'Play or pause';
}

function renderValues() {
    const pitch = state ? state.pitch : 0;
    const tune = state ? state.tune : 0;
    const pct = tempoPct();

    el.pitchDisplay.textContent = signed(pitch, 0);
    el.tuneDisplay.textContent = signed(tune, 2);
    el.tempoDisplay.textContent = pct + '%';

    if (!el.pitchSlider.matches(':active')) el.pitchSlider.value = pitch;
    if (!el.tuneSlider.matches(':active')) el.tuneSlider.value = tune;
    el.tempoSlider.max = String(tempoToSlider(tempoMax()));
    if (!el.tempoSlider.matches(':active')) el.tempoSlider.value = tempoToSlider(pct);
}

function pctOf(t, d) {
    return d > 0 ? clamp((t / d) * 100, 0, 100) + '%' : '0%';
}

function renderTimeline() {
    const media = hasMedia();
    const d = media ? state.duration : 0;
    const t = media ? state.currentTime : 0;

    el.position.textContent = media ? formatTime(t) : '--:--';
    el.duration.textContent = media && d > 0 ? formatTime(d) : '--:--';
    el.timelineProgress.style.width = pctOf(t, d);
    el.playhead.style.left = pctOf(t, d);

    const a = media ? state.loopA : null;
    const b = media ? state.loopB : null;
    el.loopA.classList.toggle('active', a != null);
    el.loopB.classList.toggle('active', b != null);
    el.markerA.style.display = a != null && d > 0 ? 'block' : 'none';
    el.markerB.style.display = b != null && d > 0 ? 'block' : 'none';
    if (a != null) el.markerA.style.left = pctOf(a, d);
    if (b != null) el.markerB.style.left = pctOf(b, d);
    if (a != null && b != null && d > 0) {
        el.timelineLoop.style.display = 'block';
        el.timelineLoop.style.left = pctOf(a, d);
        el.timelineLoop.style.width = pctOf(b - a, d);
    } else {
        el.timelineLoop.style.display = 'none';
    }
}

function stageLabel(stem) {
    if (stem.stage === 'loading') {
        // Only the model download reports "loading" past 10%.
        return stem.progress > 0.1 ? 'Downloading model' : 'Loading model';
    }
    if (stem.stage === 'separating') return stem.progress >= 0.9 ? 'Finalizing' : 'Separating';
    return STAGE_LABELS[stem.stage] || 'Working';
}

function renderStems() {
    const connected = !!(state && state.connected);
    const stem = state ? state.stem : null;
    const phase = stem ? stem.phase : 'idle';
    const btn = el.stemsButton;

    groups.stems.classList.toggle('disabledState', !connected);
    btn.classList.remove('stem-active', 'stem-recording');
    el.stemsStatus.classList.remove('error');
    el.stemsStatus.textContent = '';
    el.stemsStatus.title = '';
    el.stemsProgress.classList.toggle('hidden', phase !== 'working');
    el.stemToggles.classList.toggle('hidden', phase !== 'ready');
    btn.disabled = !connected;

    const canFetch = !!(state && state.src);
    switch (phase) {
        case 'recording':
            btn.textContent = 'Stop';
            btn.classList.add('stem-recording');
            el.stemsStatus.textContent = 'Recording';
            break;
        case 'working': {
            btn.textContent = canFetch ? 'Separate' : 'Record';
            btn.disabled = true;
            const label = stageLabel(stem);
            el.stemsStatus.textContent = label;
            el.stemsFill.style.width = Math.round(stem.progress * 100) + '%';
            el.stemsText.textContent = label + ' ' + Math.round(stem.progress * 100) + '%';
            break;
        }
        case 'ready':
            btn.textContent = stem.active ? 'Active' : 'Activate';
            if (stem.active) btn.classList.add('stem-active');
            el.stemsStatus.textContent = 'Ready';
            break;
        case 'error':
            btn.textContent = 'Retry';
            el.stemsStatus.textContent = 'Failed';
            el.stemsStatus.classList.add('error');
            if (stem.message) el.stemsStatus.title = stem.message;
            break;
        default:
            btn.textContent = canFetch ? 'Separate' : 'Record';
    }

    const states = stem ? stem.states || {} : {};
    document.querySelectorAll('.stem-toggle').forEach((t) => {
        t.disabled = !(connected && phase === 'ready' && stem.active);
        t.classList.toggle('active', states[t.dataset.stem] !== false);
    });
}

function render() {
    renderStatus();
    renderControls();
    renderValues();
    renderTimeline();
    renderStems();
}

// ─── Per-page memory ───

function pageKey() {
    if (!state || !state.url) return null;
    try {
        const u = new URL(state.url);
        u.hash = '';
        return u.href;
    } catch (err) {
        return null;
    }
}

async function restorePage() {
    const key = pageKey();
    if (!key) return;
    const data = await chrome.storage.local.get(PAGES_KEY);
    const saved = (data[PAGES_KEY] || {})[key];
    lastSaved = saved ? {pitch: saved.pitch, tune: saved.tune, tempo: saved.tempo} : null;
    if (!saved || !state) return;
    const tempo = clamp(saved.tempo, TEMPO_MIN / 100, tempoMax() / 100);
    log('restoring saved settings for', key);
    state.pitch = saved.pitch;
    state.tune = saved.tune;
    state.tempo = tempo;
    send('set-all', {pitch: saved.pitch, tune: saved.tune, tempo});
    render();
}

let saveTimer = null;
function scheduleSave() {
    const key = pageKey();
    if (!key || !restoreChecked) return;
    const current = {pitch: state.pitch, tune: state.tune, tempo: state.tempo};
    if (lastSaved && lastSaved.pitch === current.pitch && lastSaved.tune === current.tune &&
        lastSaved.tempo === current.tempo) return;
    lastSaved = current;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const data = await chrome.storage.local.get(PAGES_KEY);
        const pages = data[PAGES_KEY] || {};
        if (current.pitch === 0 && current.tune === 0 && current.tempo === 1) {
            delete pages[key];
        } else {
            pages[key] = Object.assign({savedAt: Date.now()}, current);
            const keys = Object.keys(pages);
            if (keys.length > MAX_PAGES) {
                keys.sort((x, y) => pages[x].savedAt - pages[y].savedAt);
                keys.slice(0, keys.length - MAX_PAGES).forEach((k) => delete pages[k]);
            }
        }
        await chrome.storage.local.set({[PAGES_KEY]: pages});
    }, SAVE_DELAY_MS);
}

// ─── Speed ramp ───

function onLoopJump() {
    if (!el.rampToggle.checked || !hasMedia()) return;
    const step = clamp(parseInt(el.rampStep.value, 10) || 5, 1, 50);
    const target = clamp(parseInt(el.rampTarget.value, 10) || 100, TEMPO_MIN, TEMPO_MAX);
    const current = tempoPct();
    if (current < target) setTempoPct(Math.min(target, current + step));
    if (tempoPct() >= target) {
        el.rampToggle.checked = false;
        toast('Target speed reached');
    }
}

// ─── Background messages ───

function onMessage(msg) {
    switch (msg.kind) {
        case 'state':
            unsupported = false;
            state = msg.state;
            if (msg.fresh && !restoreStarted) {
                restoreStarted = true;
                restorePage()
                    .catch((err) => log('restore failed', err.message))
                    .finally(() => {
                        restoreChecked = true;
                    });
            } else if (state && !restoreStarted && state.connected) {
                restoreStarted = true;
                // An existing capture already has the right values.
                restoreChecked = true;
                lastSaved = {pitch: state.pitch, tune: state.tune, tempo: state.tempo};
            } else if (state) {
                scheduleSave();
            }
            render();
            break;
        case 'stem':
            if (state) state.stem = msg.stem;
            renderStems();
            break;
        case 'loop-result':
            if (!msg.ok) {
                toast(msg.reason === 'invalid-point'
                    ? (msg.cmd === 'loop-a' ? 'Loop start must be before the end' : 'Loop end must be after the start')
                    : 'No media to loop');
            }
            break;
        case 'loop-jump':
            onLoopJump();
            break;
        case 'unsupported':
            unsupported = true;
            state = null;
            render();
            break;
        case 'error':
            toast(msg.message);
            break;
    }
}

function connect() {
    port = chrome.runtime.connect({name: 'ks-popup'});
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
        port = null;
    });
}

// ─── Theme ───

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    el.sun.classList.toggle('hidden', theme === 'light');
    el.moon.classList.toggle('hidden', theme !== 'light');
}

chrome.storage.local.get('theme').then((data) => applyTheme(data.theme === 'light' ? 'light' : 'dark'));

el.theme.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    chrome.storage.local.set({theme: next});
});

// ─── Control events ───

el.pitchSlider.min = '-12';
el.pitchSlider.max = '12';
el.pitchSlider.step = '1';
el.tuneSlider.min = '-1';
el.tuneSlider.max = '1';
el.tuneSlider.step = '0.01';
el.tempoSlider.min = '0';
el.tempoSlider.max = String(SLIDER_MAX);
el.tempoSlider.step = '1';

el.disconnect.addEventListener('click', () => {
    send('disconnect');
    // Give the port a moment to deliver the message before the popup closes.
    setTimeout(() => window.close(), 100);
});

el.pitchSlider.addEventListener('input', () => setPitch(Number(el.pitchSlider.value)));
el.tuneSlider.addEventListener('input', () => setTune(Number(el.tuneSlider.value)));
el.tempoSlider.addEventListener('input', () => setTempoPct(sliderToTempo(Number(el.tempoSlider.value))));

document.querySelectorAll('.pitchButton').forEach((b) => {
    b.addEventListener('click', () => setPitch((state ? state.pitch : 0) + Number(b.value)));
});
document.querySelectorAll('.tuneButton').forEach((b) => {
    b.addEventListener('click', () => setTune((state ? state.tune : 0) + Number(b.value)));
});
document.querySelectorAll('.tempoButton').forEach((b) => {
    b.addEventListener('click', () => setTempoPct(tempoPct() + Number(b.value) * 100));
});

el.pitchReset.addEventListener('click', () => setPitch(0));
el.tuneReset.addEventListener('click', () => setTune(0));
el.tempoReset.addEventListener('click', () => setTempoPct(100));

el.skipStart.addEventListener('click', () => send('seek-start'));
el.seekBack.addEventListener('click', () => send('seek-by', {delta: -SEEK_STEP}));
el.seekFwd.addEventListener('click', () => send('seek-by', {delta: SEEK_STEP}));
el.play.addEventListener('click', () => {
    if (hasMedia()) {
        send('toggle-play');
    } else {
        send('resync');
        toast('Audio resynced');
    }
});

el.loopA.addEventListener('click', () => send('loop-a'));
el.loopB.addEventListener('click', () => send('loop-b'));
el.loopReset.addEventListener('click', () => send('loop-clear'));

el.timelineBar.addEventListener('click', (ev) => {
    if (!hasMedia() || !(state.duration > 0)) return;
    const rect = el.timelineBar.getBoundingClientRect();
    const ratio = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
    send('seek-to', {time: ratio * state.duration});
});

el.rampStep.addEventListener('change', () => {
    el.rampStep.value = clamp(parseInt(el.rampStep.value, 10) || 5, 1, 50);
});
el.rampTarget.addEventListener('change', () => {
    el.rampTarget.value = clamp(parseInt(el.rampTarget.value, 10) || 100, TEMPO_MIN, TEMPO_MAX);
});

el.stemsButton.addEventListener('click', () => {
    if (!state || !state.connected) return;
    const stem = state.stem || {phase: 'idle'};
    if (stem.phase === 'recording') {
        send('stem-record-stop');
        return;
    }
    if (stem.phase === 'ready') {
        send(stem.active ? 'stem-deactivate' : 'stem-activate');
        return;
    }
    if (!state.src) {
        send('stem-record-start');
        return;
    }
    // Ask for access to the audio's origin so the file can be fetched. Best effort.
    let origin = null;
    try {
        origin = new URL(state.src).origin + '/*';
    } catch (err) {
        origin = null;
    }
    const request = origin
        ? chrome.permissions.request({origins: [origin]}).catch(() => false)
        : Promise.resolve(false);
    request.finally(() => send('stem-separate'));
});

document.querySelectorAll('.stem-toggle').forEach((t) => {
    t.addEventListener('click', () => send('stem-toggle', {stem: t.dataset.stem}));
});

// ─── Keyboard shortcuts ───

document.addEventListener('keydown', (ev) => {
    const target = ev.target;
    if (target instanceof HTMLInputElement && target.type === 'number') return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (!state || !state.connected) return;
    const media = hasMedia();
    let handled = true;

    switch (ev.key) {
        case 'ArrowUp':
            if (ev.shiftKey) setTune(state.tune + 0.1);
            else setPitch(state.pitch + 1);
            break;
        case 'ArrowDown':
            if (ev.shiftKey) setTune(state.tune - 0.1);
            else setPitch(state.pitch - 1);
            break;
        case '[':
            if (media) setTempoPct(tempoPct() - TEMPO_KEY_STEP);
            break;
        case ']':
            if (media) setTempoPct(tempoPct() + TEMPO_KEY_STEP);
            break;
        case ' ':
            if (media) send('toggle-play');
            break;
        case 'a':
        case 'A':
            if (media) send('loop-a');
            break;
        case 'b':
        case 'B':
            if (media) send('loop-b');
            break;
        case 'Escape':
            if (media) send('loop-clear');
            break;
        case '0':
            if (media) send('seek-start');
            break;
        case 'r':
        case 'R':
            resetAll();
            break;
        default:
            handled = false;
    }
    if (handled) ev.preventDefault();
});

render();
connect();
