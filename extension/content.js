'use strict';

(() => {
    // The background injects this file every time the popup opens.
    if (window.__keyshiftContent) return;
    window.__keyshiftContent = true;

    const log = (...args) => console.log('[KS:content]', ...args);

    const REPORT_INTERVAL_MS = 250;
    const FIND_RETRY_MS = 250;
    const FIND_TIMEOUT_MS = 3000;
    const LOOP_CHECK_MS = 50;
    const MEDIA_EVENTS = ['timeupdate', 'play', 'pause', 'durationchange', 'ratechange', 'loadedmetadata', 'emptied'];

    let media = null;
    let mediaSrc = null;
    let reporting = false;
    let desiredRate = null;
    let loopA = null;
    let loopB = null;
    let loopTimer = null;
    let lastReport = 0;
    let reportTimer = null;

    // ─── Finding the media element ───

    function isPlaying(el) {
        return !el.paused && !el.ended && el.readyState > 2;
    }

    function findMedia() {
        const all = Array.from(document.querySelectorAll('video, audio'));
        if (all.length === 0) return null;
        const playing = all.find(isPlaying);
        if (playing) return playing;
        let best = null;
        for (const el of all) {
            const d = isFinite(el.duration) ? el.duration : 0;
            if (d > 0 && (!best || d > best.duration)) best = el;
        }
        return best || all[0];
    }

    function srcOf(el) {
        const raw = el.currentSrc || el.src || '';
        if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) return null;
        try {
            return new URL(raw, location.href).href;
        } catch (err) {
            return null;
        }
    }

    function trackKey(el) {
        return el ? (el.currentSrc || el.src || '') : '';
    }

    function attach(el) {
        if (el === media) return;
        if (media) MEDIA_EVENTS.forEach((ev) => media.removeEventListener(ev, onMediaEvent));
        media = el;
        mediaSrc = trackKey(el);
        clearLoop();
        if (media) {
            MEDIA_EVENTS.forEach((ev) => media.addEventListener(ev, onMediaEvent));
            if (desiredRate != null) applyRate();
            log('media element attached', media.tagName);
        }
        report(true);
    }

    function refreshMedia() {
        if (media && !media.isConnected) attach(null);
        const found = findMedia();
        if (found && found !== media) {
            // Keep the current element unless the new one is playing and ours is not.
            if (!media || (isPlaying(found) && !isPlaying(media))) attach(found);
        }
        return media;
    }

    // Some players create the element late, so poll for a short time.
    function waitForMedia() {
        return new Promise((resolve) => {
            const started = Date.now();
            const tick = () => {
                if (refreshMedia() || Date.now() - started >= FIND_TIMEOUT_MS) {
                    resolve(media);
                    return;
                }
                setTimeout(tick, FIND_RETRY_MS);
            };
            tick();
        });
    }

    // ─── State reporting ───

    function snapshot() {
        if (!media) {
            return {hasMedia: false, title: document.title};
        }
        return {
            hasMedia: true,
            currentTime: media.currentTime || 0,
            duration: isFinite(media.duration) ? media.duration : 0,
            paused: media.paused,
            playbackRate: media.playbackRate,
            loopA,
            loopB,
            src: srcOf(media),
            title: document.title
        };
    }

    function sendReport() {
        lastReport = Date.now();
        chrome.runtime.sendMessage({ks: 'media-state', state: snapshot()}).catch(() => {});
    }

    // Throttled to about 4 per second, with a trailing report so the last change is sent.
    function report(force) {
        if (!reporting) return;
        clearTimeout(reportTimer);
        const wait = REPORT_INTERVAL_MS - (Date.now() - lastReport);
        if (force || wait <= 0) {
            sendReport();
        } else {
            reportTimer = setTimeout(sendReport, wait);
        }
    }

    function onMediaEvent(ev) {
        if (ev.type === 'emptied' || ev.type === 'loadedmetadata') {
            const key = trackKey(media);
            if (key !== mediaSrc) {
                mediaSrc = key;
                clearLoop();
                if (desiredRate != null) applyRate();
            }
        }
        if (ev.type === 'timeupdate') checkLoop();
        report(ev.type !== 'timeupdate');
    }

    // ─── Loop ───

    function clearLoop() {
        loopA = null;
        loopB = null;
        updateLoopTimer();
    }

    function updateLoopTimer() {
        const active = loopA != null && loopB != null;
        if (active && !loopTimer) {
            loopTimer = setInterval(checkLoop, LOOP_CHECK_MS);
        } else if (!active && loopTimer) {
            clearInterval(loopTimer);
            loopTimer = null;
        }
    }

    function checkLoop() {
        if (!media || loopA == null || loopB == null || media.paused) return;
        const t = media.currentTime;
        if (t >= loopB || t < loopA - 0.25) {
            media.currentTime = loopA;
            chrome.runtime.sendMessage({ks: 'loop-jump'}).catch(() => {});
        }
    }

    // ─── Commands ───

    function applyRate() {
        if (!media || desiredRate == null) return;
        media.preservesPitch = true;
        media.playbackRate = desiredRate;
    }

    function seek(time) {
        if (!media) return;
        const max = isFinite(media.duration) ? media.duration : time;
        media.currentTime = Math.max(0, Math.min(max, time));
    }

    function handle(msg) {
        refreshMedia();
        switch (msg.action) {
            case 'report':
                reporting = !!msg.on;
                if (reporting) report(true);
                return {ok: true};
            case 'set-rate':
                desiredRate = msg.rate;
                applyRate();
                return {ok: true};
            case 'toggle-play':
                if (!media) return {ok: false, reason: 'no-media'};
                if (media.paused) {
                    media.play().catch(() => {});
                } else {
                    media.pause();
                }
                return {ok: true};
            case 'seek-by':
                if (media) seek(media.currentTime + (msg.delta || 0));
                return {ok: !!media};
            case 'seek-start':
                if (media) seek(0);
                return {ok: !!media};
            case 'seek-to':
                if (media) seek(msg.time || 0);
                return {ok: !!media};
            case 'loop-a': {
                if (!media) return {ok: false, reason: 'no-media'};
                const t = media.currentTime;
                if (loopB != null && t >= loopB) return {ok: false, reason: 'invalid-point', state: snapshot()};
                loopA = t;
                break;
            }
            case 'loop-b': {
                if (!media) return {ok: false, reason: 'no-media'};
                const t = media.currentTime;
                if (loopA != null && t <= loopA) return {ok: false, reason: 'invalid-point', state: snapshot()};
                loopB = t;
                break;
            }
            case 'loop-clear':
                clearLoop();
                break;
            default:
                return {ok: false, reason: 'unknown'};
        }
        updateLoopTimer();
        report(true);
        return {ok: true, state: snapshot()};
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.ks !== 'cmd') return;
        if (msg.action === 'get-state') {
            waitForMedia().then(() => sendResponse(snapshot()));
            return true;
        }
        sendResponse(handle(msg));
    });

    // ─── Watch for new media elements ───

    let domTimer = null;
    const observer = new MutationObserver(() => {
        clearTimeout(domTimer);
        domTimer = setTimeout(() => {
            const before = media;
            refreshMedia();
            if (media !== before) report(true);
        }, 200);
    });
    observer.observe(document.documentElement, {childList: true, subtree: true});

    // A playing element that starts later should take over from a paused one.
    document.addEventListener('play', (ev) => {
        const el = ev.target;
        if (el instanceof HTMLMediaElement && el !== media && (!media || media.paused)) attach(el);
    }, true);

    refreshMedia();
})();
